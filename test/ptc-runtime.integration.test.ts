import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import NodePtcRuntime from "@deepseek-ai/dsh-ptc-runtime-node";
import LocalSandbox from "@deepseek-ai/dsh-sandbox-local";
import SandboxPolicy from "@deepseek-ai/dsh-sandbox-policy";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import LocalSubprocess from "@deepseek-ai/dsh-subprocess-local";
import { expect, it } from "vitest";

it("bounds real PTC output and drains its process on timeout, cancellation, and owner disposal", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dsh-ptc-contract-"));
  const ctx = new Context();
  const pids: number[] = [];
  const processGone = (pid: number | undefined) => {
    if (pid === undefined) throw new Error("PTC process never reported its PID");
    expect(() => process.kill(pid, 0)).toThrow();
  };
  try {
    await ctx.plugin(LocalFileSystem, { cwd: workspace });
    await ctx.plugin(SessionProjection);
    await ctx.plugin(SandboxPolicy, { mode: "read-only", workspaceRoot: workspace });
    await ctx.plugin(LocalSandbox);
    await ctx.plugin(LocalSubprocess);
    await ctx.plugin(NodePtcRuntime, { maxOutputBytes: 1024, timeoutMs: 5000, graceMs: 500 });
    const runtime = ctx.ptcRuntime;
    const recordStarted = (value: unknown) => {
      if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
        throw new Error("PTC process did not supply a valid PID");
      }
      pids.push(value);
      return Promise.resolve(null);
    };
    const bindings = [{ global: "evidence", functions: { started: recordStarted } }];
    const started = "await evidence.started((await import('node:process')).pid);";
    const successful = await runtime.run(
      runtime.resolve({
        program: `${started} return { marker: 'PTC_REAL_PROCESS', envKeys: Object.keys(process.env) };`,
        bindings,
      }),
    );
    expect(successful).toMatchObject({ value: { marker: "PTC_REAL_PROCESS", envKeys: [] } });
    expect(successful.error).toBeUndefined();
    expect(pids).toHaveLength(1);
    processGone(pids[0]);

    const bounded = await runtime.run(
      runtime.resolve({
        program: `${started} return 'x'.repeat(4096);`,
        bindings,
      }),
    );
    expect(bounded.error?.kind).toBe("output-limit");
    expect(bounded.value).toBeUndefined();
    processGone(pids[1]);

    const timedOut = await runtime.run(
      runtime.resolve({
        program: `${started} while (true) {}`,
        bindings,
        timeoutMs: 1000,
      }),
    );
    expect(timedOut.error?.kind).toBe("timeout");
    expect(pids).toHaveLength(3);
    processGone(pids[2]);

    for (const shutdown of ["abort", "dispose"] as const) {
      const controller = new AbortController();
      let markStarted!: () => void;
      const ready = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const running = runtime.run(
        runtime.resolve({
          program: `${started} while (true) {}`,
          signal: controller.signal,
          bindings: [
            {
              global: "evidence",
              functions: {
                started: async (value: unknown) => {
                  await recordStarted(value);
                  markStarted();
                  return null;
                },
              },
            },
          ],
        }),
      );
      await ready;
      if (shutdown === "abort") controller.abort(new Error("Controller cancellation fixture"));
      else await ctx.fiber.dispose();
      expect((await running).error?.kind).toBe("abort");
      processGone(pids.at(-1));
    }
    expect(pids).toHaveLength(5);
  } finally {
    await ctx.fiber.dispose();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
