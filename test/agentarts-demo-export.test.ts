import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Script } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = promisify(execFile);
const exporter = resolve("agentarts/demo/export.mjs");
let root: string;
let recordPath: string;
let outputPath: string;
const record = {
  schemaVersion: 1,
  mode: "simulation",
  task: {
    id: "synthetic-cli-schema-fixture",
    repository: "fixture/review",
    pullNumber: 1,
    headSha: "a".repeat(40),
    url: "",
  },
  stages: [
    {
      name: "Synthetic validation",
      status: "passed",
      startedAt: "2026-10-04T00:00:00Z",
      completedAt: "2026-10-04T00:00:01Z",
    },
  ],
  tools: [{ id: "workspace.read", ok: true, durationMs: 7 }],
  validation: { status: "passed", checks: ["CLI schema fixture only"] },
  durationMs: 1000,
  warnings: ["Synthetic export test; no model, cloud or GitHub execution."],
};
const run = (...args: string[]) =>
  execute(process.execPath, [exporter, ...args], { maxBuffer: 64 * 1024 });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentarts-static-export-test-"));
  recordPath = join(root, "source.json");
  outputPath = join(root, "new-site");
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("AgentArts static Demo exporter (local CLI, no cloud or publication)", () => {
  it("exports the saved real local DSH run evidence without changing its mode, timestamps or task", async () => {
    const evidence = resolve("agentarts/evidence/local-run-record.json");
    const original = await readFile(evidence);
    await run("--record", evidence, "--out", outputPath);
    expect(await readFile(join(outputPath, "run-record.json"))).toEqual(original);
    expect(await readFile(evidence)).toEqual(original);
  });
  it.each(["fix-test-failed", "implement-partial-success"])(
    "exports the labelled %s UI example byte-for-byte",
    async (name) => {
      const evidence = resolve("agentarts/demo/examples/" + name + ".json");
      const original = await readFile(evidence);
      await run("--record", evidence, "--out", outputPath);
      expect((JSON.parse(original.toString("utf8")) as { mode?: unknown }).mode).toBe("simulation");
      expect(await readFile(join(outputPath, "run-record.json"))).toEqual(original);
    },
  );

  it("preserves the complete original record bytes and adds snapshot CSP without remote assets", async () => {
    const original = await readFile(recordPath);
    const { stdout } = await run("--record", recordPath, "--out", outputPath);
    expect(await readdir(outputPath)).toEqual(["index.html", "run-record.json"]);
    expect(await readFile(join(outputPath, "run-record.json"))).toEqual(original);
    expect(await readFile(recordPath)).toEqual(original);
    expect(stdout).toContain("必须人工审查");
    const html = await readFile(join(outputPath, "index.html"), "utf8");
    expect(html).toContain('name="agentarts-record-source" content="static-export"');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("connect-src 'self'");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("unsafe-inline");
    expect(html).not.toMatch(/<(?:script|link)\b[^>]*(?:src|href)\s*=/iu);
    for (const tag of ["script", "style"]) {
      const content = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(html)?.[1];
      expect(content).toBeDefined();
      const hash = createHash("sha256")
        .update(content ?? "")
        .digest("base64");
      expect(html).toContain(`'sha256-${hash}'`);
    }
    expect(html).toContain('fetch("./run-record.json"');
    expect(new URL("./run-record.json", "https://example.test/project/index.html").pathname).toBe(
      "/project/run-record.json",
    );
  });

  it.each([
    ["unknown schema", { ...record, schemaVersion: 2 }],
    ["container evidence", { schemaVersion: 1, mode: "container", status: "passed" }],
    ["raw Runtime response", { schemaVersion: 1, taskId: "raw", output: {}, toolReceipts: [] }],
    ["unknown mode", { ...record, mode: "cloud-real" }],
    ["unknown operation", { ...record, task: { ...record.task, operation: "deploy" } }],
    ["observed tool object", { ...record, observedTools: [{ id: "Read", ok: true }] }],
    ["overlong observed tool", { ...record, observedTools: ["x".repeat(129)] }],
    ["unknown write status", { ...record, result: { writeStatus: "probably-success" } }],
    ["invalid commit", { ...record, result: { commitSha: "main" } }],
    [
      "unknown original validation",
      {
        ...record,
        validation: { ...record.validation, original: { status: "pretend", commandCount: 1 } },
      },
    ],
    [
      "invalid original validation count",
      {
        ...record,
        validation: { ...record.validation, original: { status: "passed", commandCount: -1 } },
      },
    ],
    [
      "original validation credential",
      {
        ...record,
        validation: {
          ...record.validation,
          original: { status: "passed", commandCount: 1, apiKey: "synthetic-hidden-key" },
        },
      },
    ],
    ["bad validation", { ...record, validation: { status: "passed", checks: [17] } }],
    ["unknown stage state", { ...record, stages: [{ ...record.stages[0], status: "pretend" }] }],
    ["credential root field", { ...record, apiKey: "synthetic-private-key" }],
    ["base commit must be text", { ...record, task: { ...record.task, baseSha: 17 } }],
    ["unknown model kind", { ...record, modelEvidence: { kind: "real", provider: "deepseek" } }],
    [
      "unknown model provider",
      { ...record, modelEvidence: { kind: "live-provider", provider: "other" } },
    ],
    [
      "model must be text",
      { ...record, modelEvidence: { kind: "live-provider", provider: "deepseek", model: 17 } },
    ],
    [
      "nested model credential",
      {
        ...record,
        modelEvidence: {
          kind: "live-provider",
          provider: "deepseek",
          apiKey: "synthetic-private-key",
        },
      },
    ],
    [
      "nested raw headers",
      { ...record, runtime: { sessionId: "fixture", headers: { Authorization: "fixture-key" } } },
    ],
  ])("rejects %s without creating an output directory", async (_name, payload) => {
    await writeFile(recordPath, JSON.stringify(payload));
    await expect(run("--record", recordPath, "--out", outputPath)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["source.json"]);
  });

  it.each(["live-provider", "deterministic-fixture", "unverified"])(
    "preserves explicitly recorded model evidence kind %s",
    async (kind) => {
      const payload = JSON.stringify({
        ...record,
        modelEvidence: { kind, provider: "deepseek", model: "synthetic-schema-model" },
      });
      await writeFile(recordPath, payload);
      await run("--record", recordPath, "--out", outputPath);
      expect(await readFile(join(outputPath, "run-record.json"), "utf8")).toBe(payload);
    },
  );

  it.each([
    [
      "overwritten root runtime",
      `${JSON.stringify(record).slice(0, -1)},"runtime":{"headers":{"Authorization":"synthetic-hidden-key"}},"runtime":{}}`,
    ],
    [
      "nested known result field",
      `${JSON.stringify(record).slice(0, -1)},"result":{"summary":"synthetic-hidden-key","summary":"safe"}}`,
    ],
    [
      "escaped root equivalent",
      `${JSON.stringify(record).slice(0, -1)},"runtime":{"headers":{"Authorization":"synthetic-hidden-key"}},"r\\u0075ntime":{}}`,
    ],
    [
      "escaped nested equivalent",
      `${JSON.stringify(record).slice(0, -1)},"result":{"summary":"synthetic-hidden-key","summ\\u0061ry":"safe"}}`,
    ],
    [
      "nested object inside an array",
      JSON.stringify({ ...record, stages: [] }).replace(
        '"stages":[]',
        '"stages":[{"name":"fixture","status":"failed","status":"passed","startedAt":"2026-10-04T00:00:00Z"}]',
      ),
    ],
  ])(
    "rejects duplicate JSON keys: %s, before creating output or printing values",
    async (_name, payload) => {
      await writeFile(recordPath, payload);
      await expect(run("--record", recordPath, "--out", outputPath)).rejects.toThrow(
        /duplicate JSON keys/u,
      );
      try {
        await run("--record", recordPath, "--out", outputPath);
      } catch (error: unknown) {
        expect(String(error)).not.toContain("synthetic-hidden-key");
      }
      expect(await readdir(root)).toEqual(["source.json"]);
      expect(await readFile(recordPath, "utf8")).toBe(payload);
    },
  );

  it("preserves an optional base commit without filling it into historical records", async () => {
    const payload = JSON.stringify({
      ...record,
      task: { ...record.task, baseSha: "b".repeat(40) },
    });
    await writeFile(recordPath, payload);
    await run("--record", recordPath, "--out", outputPath);
    expect(await readFile(join(outputPath, "run-record.json"), "utf8")).toBe(payload);
  });
  it.each(["issue", "repository"])("accepts explicit read-only %s task metadata", async (kind) => {
    const payload = JSON.stringify({
      ...record,
      task: { ...record.task, pullNumber: 0, kind, operation: "task" },
    });
    await writeFile(recordPath, payload);
    await run("--record", recordPath, "--out", outputPath);
    expect(await readFile(join(outputPath, "run-record.json"), "utf8")).toBe(payload);
  });

  it.each(["fix", "implement"])(
    "preserves %s write and original validation metadata without filling historical records",
    async (operation) => {
      const payload = JSON.stringify({
        ...record,
        task: { ...record.task, operation, kind: operation === "fix" ? "pull_request" : "issue" },
        validation: { ...record.validation, original: { status: "passed", commandCount: 2 } },
        result: {
          writeStatus: "partial-success",
          commitSha: "c".repeat(40),
          branchName: "fixture/fix",
          githubUrl: "https://github.com/fixture/review/commit/" + "c".repeat(40),
          error: "Simulation UI fixture: later comment failed.",
        },
      });
      await writeFile(recordPath, payload);
      await run("--record", recordPath, "--out", outputPath);
      expect(await readFile(join(outputPath, "run-record.json"), "utf8")).toBe(payload);
      expect(await readFile(recordPath, "utf8")).toBe(payload);
    },
  );
  it("does not present an explicitly unfinished tool as completed success", async () => {
    const view = await renderSnapshot({
      ...record,
      tools: [{ id: "workspace.read", ok: true, completed: false, durationMs: 7 }],
    });
    expect(view.element("tools").children[0]?.children[1]?.children[0]?.textContent).toBe("未完成");
  });
  it("keeps observed native names distinct from successful execution receipts", async () => {
    const payload = { ...record, tools: [], observedTools: ["Read", "Bash", "<img src=x>"] };
    await writeFile(recordPath, JSON.stringify(payload));
    await run("--record", recordPath, "--out", outputPath);
    expect(await readFile(join(outputPath, "run-record.json"), "utf8")).toBe(
      JSON.stringify(payload),
    );
    const view = await renderSnapshot(payload);
    expect(view.element("toolCount").textContent).toBe("0 次调用");
    expect(view.element("observedToolsPanel").classList.contains("hidden")).toBe(false);
    expect(view.element("observedTools").children.map((child) => child.textContent)).toEqual(
      payload.observedTools,
    );
  });

  it.each([
    {
      operation: "fix",
      title: "PR 修复运行记录",
      writeStatus: "success",
      validationStatus: "passed",
      originalStatus: "passed",
      error: "",
      expectedOutcome: "阶段已结束",
    },
    {
      operation: "implement",
      title: "Issue 实现运行记录",
      writeStatus: "no-changes",
      validationStatus: "not-run",
      originalStatus: "not-applicable",
      error: "",
      expectedOutcome: "阶段已结束",
    },
    {
      operation: "fix",
      title: "PR 修复运行记录",
      writeStatus: undefined,
      validationStatus: "failed",
      originalStatus: "failed",
      error: "Simulation fixture: independent tests failed; no publication.",
      expectedOutcome: "执行失败",
    },
    {
      operation: "implement",
      title: "Issue 实现运行记录",
      writeStatus: "partial-success",
      validationStatus: "passed",
      originalStatus: "passed",
      error: "Simulation fixture: comment failed after commit.",
      expectedOutcome: "部分写入已完成",
    },
  ])(
    "renders $operation / $writeStatus / $originalStatus as recorded without inventing effects",
    async ({
      operation,
      title,
      writeStatus,
      validationStatus,
      originalStatus,
      error,
      expectedOutcome,
    }) => {
      const payload = {
        ...record,
        task: { ...record.task, operation, kind: operation === "fix" ? "pull_request" : "issue" },
        validation: {
          status: validationStatus,
          checks: ["Simulation fixture"],
          original: { status: originalStatus, commandCount: 2 },
        },
        result: {
          ...(writeStatus ? { writeStatus } : {}),
          ...(error ? { error } : {}),
          ...(writeStatus === "partial-success"
            ? {
                githubUrl: "https://github.com/fixture/review/pull/2",
                commitSha: "c".repeat(40),
                branchName: "fixture/implement",
              }
            : {}),
        },
      };
      const view = await renderSnapshot(payload);
      expect(view.element("title").textContent).toBe(title);
      expect(view.element("mode").textContent).toBe("模拟运行");
      expect(view.element("sourceBadge").textContent).toBe("历史回放 · 静态页面");
      expect(view.element("taskStatus").textContent).toBe(expectedOutcome);
      expect(view.element("validationOriginal").textContent).toContain("2 条命令");
      expect(view.element("resultError").textContent).toBe(error);
      if (writeStatus === "partial-success") {
        expect(view.element("writeStatus").textContent).toContain("先核对已有效果");
        expect(view.element("writeDetails").textContent).toContain("c".repeat(40));
        expect(view.element("resultLink").children[0]?.href).toBe(
          "https://github.com/fixture/review/pull/2",
        );
        expect(view.element("resultLink").children[0]?.textContent).toContain("已记录 GitHub 效果");
        expect(
          view
            .element("warnings")
            .children.some((warning) => warning.textContent.includes("不能盲目")),
        ).toBe(true);
      } else {
        expect(view.element("resultLink").classList.contains("hidden")).toBe(true);
        expect(view.element("resultLinkEmpty").classList.contains("hidden")).toBe(false);
      }
      expect(view.scheduled).not.toHaveBeenCalled();
    },
  );

  it("bounds scanning depth and nodes before JSON.parse or directory creation", async () => {
    await writeFile(recordPath, `${"[".repeat(41)}0${"]".repeat(41)}`);
    await expect(run("--record", recordPath, "--out", outputPath)).rejects.toThrow(
      /JSON depth limit/u,
    );
    await writeFile(recordPath, `[${"0,".repeat(200001)}0]`);
    await expect(run("--record", recordPath, "--out", outputPath)).rejects.toThrow(
      /JSON scan node limit/u,
    );
    expect(await readdir(root)).toEqual(["source.json"]);
  });

  it("keeps quoted delimiters and escaped literal strings intact without false duplicate detection", async () => {
    const payload = JSON.stringify({
      ...record,
      result: { summary: 'Quoted "key", braces {[]}, comma, and \\ remain ordinary data.' },
    });
    await writeFile(recordPath, payload);
    await run("--record", recordPath, "--out", outputPath);
    expect(await readFile(join(outputPath, "run-record.json"), "utf8")).toBe(payload);
  });

  it("prints fixed parse errors without leaking invalid input text", async () => {
    await writeFile(recordPath, '{"synthetic-hidden-key": +');
    try {
      await run("--record", recordPath, "--out", outputPath);
    } catch (error: unknown) {
      expect(String(error)).toContain("Record must be valid UTF-8 JSON");
      expect(String(error)).not.toContain("synthetic-hidden-key");
    }
    expect(await readdir(root)).toEqual(["source.json"]);
  });

  it("refuses an existing output path without changing its files", async () => {
    await run("--record", recordPath, "--out", outputPath);
    await writeFile(join(outputPath, "operator-marker.txt"), "must remain");
    const exported = await readFile(join(outputPath, "run-record.json"));
    await expect(run("--record", recordPath, "--out", outputPath)).rejects.toThrow(
      /already exists/u,
    );
    expect(await readFile(join(outputPath, "run-record.json"))).toEqual(exported);
    expect(await readFile(join(outputPath, "operator-marker.txt"), "utf8")).toBe("must remain");
  });

  it("requires an explicit absolute record and output option", async () => {
    await expect(run("--record", "source.json", "--out", outputPath)).rejects.toThrow(
      /absolute path/u,
    );
    await expect(run("--record", recordPath)).rejects.toThrow(/--out is required/u);
    expect(await readdir(root)).toEqual(["source.json"]);
  });

  it("rejects oversized input and malformed UTF-8 instead of rewriting either", async () => {
    await writeFile(recordPath, " ".repeat(2 * 1024 * 1024 + 1));
    await expect(run("--record", recordPath, "--out", outputPath)).rejects.toThrow(/2 MiB/u);
    await writeFile(recordPath, Buffer.from([0xc3, 0x28]));
    await expect(run("--record", recordPath, "--out", outputPath)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["source.json"]);
  });

  it("loads a static snapshot once with historical labels and no automatic polling (VM contract)", async () => {
    await run("--record", recordPath, "--out", outputPath);
    const html = await readFile(join(outputPath, "index.html"), "utf8");
    const source = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(source).toBeDefined();
    const elements = new Map<string, FakeElement>();
    const element = (id: string) => {
      let current = elements.get(id);
      if (current === undefined) {
        current = new FakeElement();
        elements.set(id, current);
      }
      return current;
    };
    element("content").classList.add("hidden");
    const fetched = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ...record, stages: [], tools: [] }))),
    );
    const scheduled = vi.fn();
    const script = new Script(source ?? "");
    script.runInNewContext({
      document: {
        getElementById: element,
        createElement: () => new FakeElement(),
        querySelector: () => ({}),
      },
      location: { protocol: "https:" },
      fetch: fetched,
      AbortSignal,
      TextEncoder,
      URL,
      setTimeout: scheduled,
      clearTimeout: vi.fn(),
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(fetched).toHaveBeenCalledOnce();
    expect(element("mode").textContent).toBe("模拟运行");
    expect(element("sourceBadge").textContent).toBe("历史回放 · 静态页面");
    expect(element("source").textContent).toContain("不会执行或跟踪任务");
    expect(element("connect").textContent).toBe("重新读取静态记录");
    expect(element("resultLink").classList.contains("hidden")).toBe(true);
    expect(element("resultLinkEmpty").classList.contains("hidden")).toBe(false);
    expect(scheduled).not.toHaveBeenCalled();
    element("connect").click();
    await new Promise<void>((done) => setImmediate(done));
    expect(fetched).toHaveBeenCalledTimes(2);
    expect(scheduled).not.toHaveBeenCalled();
  });
});

async function renderSnapshot(payload: unknown) {
  const html = await readFile(resolve("agentarts/demo/index.html"), "utf8");
  const source = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  if (source === undefined) throw new Error("Missing Demo script");
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    let current = elements.get(id);
    if (current === undefined) {
      current = new FakeElement();
      elements.set(id, current);
    }
    return current;
  };
  element("content").classList.add("hidden");
  const scheduled = vi.fn();
  new Script(source).runInNewContext({
    document: {
      getElementById: element,
      createElement: () => new FakeElement(),
      querySelector: () => ({}),
    },
    location: { protocol: "https:" },
    fetch: () => Promise.resolve(new Response(JSON.stringify(payload))),
    AbortSignal,
    TextEncoder,
    URL,
    setTimeout: scheduled,
    clearTimeout: vi.fn(),
  });
  await new Promise<void>((done) => setImmediate(done));
  return { element, scheduled };
}

class FakeElement {
  textContent = "";
  className = "";
  hidden = false;
  dateTime = "";
  href = "";
  target = "";
  rel = "";
  readonly classes = new Set<string>();
  readonly listeners = new Map<string, () => void>();
  children: FakeElement[] = [];
  readonly classList = {
    add: (value: string) => {
      this.classes.add(value);
    },
    remove: (value: string) => {
      this.classes.delete(value);
    },
    contains: (value: string) => this.classes.has(value),
    toggle: (value: string, enabled: boolean) => {
      if (enabled) this.classes.add(value);
      else this.classes.delete(value);
    },
  };
  append(...children: FakeElement[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }
  addEventListener(event: string, callback: () => void) {
    this.listeners.set(event, callback);
  }
  click() {
    this.listeners.get("click")?.();
  }
}
