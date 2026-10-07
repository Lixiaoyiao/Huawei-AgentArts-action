import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgentArtsSandbox, type AgentArtsSandboxHandle } from "../src/agentarts/sandbox.js";
import { startDeepSeekProxy, type DeepSeekProxyHandle } from "../src/dsh/proxy.js";
import { executeBoundedDshProcess } from "../src/dsh/process.js";

const actualLinux = process.platform === "linux" && process.getuid?.() === 0;
describe.skipIf(!actualLinux)("real AgentArts namespace boundary", () => {
  let root: string | undefined;
  let sandbox: AgentArtsSandboxHandle | undefined;
  let proxy: DeepSeekProxyHandle | undefined;
  afterEach(async () => {
    await sandbox?.close();
    await proxy?.close();
    sandbox = undefined;
    proxy = undefined;
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
  async function prepare(write: boolean) {
    root = await mkdtemp(join(tmpdir(), "agentarts-sandbox-proof-"));
    await chmod(root, 0o710);
    await chown(root, 0, 10001);
    const workspace = join(root, "workspace"),
      home = join(root, "home"),
      profile = join(root, "profile"),
      temporary = join(root, "tmp");
    for (const directory of [workspace, home, profile, temporary]) {
      await mkdir(directory);
      await chmod(directory, 0o750);
      await chown(directory, 10001, 10001);
    }
    await writeFile(join(workspace, "bound.txt"), "immutable baseline");
    await chmod(join(workspace, "bound.txt"), 0o644);
    await chown(join(workspace, "bound.txt"), 10001, 10001);
    await writeFile(join(root, "supervisor-secret"), "fixture-only-private-value", { mode: 0o600 });
    proxy = await startDeepSeekProxy({
      apiKey: "supervisor-fixture-key",
      baseUrl: "https://api.deepseek.com",
      socketPath: join(root, "model.sock"),
      fetchImplementation: (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer supervisor-fixture-key",
        );
        return Promise.resolve(
          new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
        );
      },
    });
    sandbox = await prepareAgentArtsSandbox({
      workspacePath: workspace,
      dshHome: home,
      workerTemporaryDirectory: temporary,
      profileRoot: profile,
      actionRoot: process.cwd(),
      workspaceWrite: write,
      networkRequested: false,
      modelProxy: proxy,
      deadlineMs: Date.now() + 10_000,
      nativeTools: write ? ["workspace.edit", "native.bash"] : ["workspace.read"],
      mode: "controlled",
    });
    return { workspace, home, temporary, sandbox, proxy, root };
  }
  it("hides supervisor files/env/processes, drops capabilities, denies host network and mounts read-only workspaces", async () => {
    const state = await prepare(false);
    const code = `const fs=require('node:fs'),os=require('node:os'); const status=fs.readFileSync('/proc/self/status','utf8'); if(process.getuid()!==10001||process.getgid()!==10001||!/^CapEff:\\s+0+$/m.test(status)||Object.keys(os.networkInterfaces()).some(n=>n!=='lo'))process.exit(40); if(fs.existsSync(${JSON.stringify(join(state.root, "supervisor-secret"))})||fs.existsSync('/proc/1/root'+${JSON.stringify(join(state.root, "supervisor-secret"))})||process.env.DEEPSEEK_API_KEY)process.exit(41); try{fs.writeFileSync('/workspace/bound.txt','overwrite');process.exit(42)}catch{}; fetch(process.env.MODEL_URL+'/v1/messages',{method:'POST',headers:{Authorization:'Bearer '+process.env.MODEL_CAPABILITY,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture',messages:[]})}).then(async r=>process.stdout.write(await r.text())).catch(()=>process.exit(43));`;
    const result = await executeBoundedDshProcess(
      state.sandbox.prepareProcess({
        command: process.execPath,
        args: ["-e", code],
        cwd: state.temporary,
        env: { MODEL_URL: state.proxy.workerBaseUrl, MODEL_CAPABILITY: state.proxy.workerToken },
      }),
      { timeoutMs: 5000, maxStdoutBytes: 4096, maxStderrBytes: 4096, maxCombinedBytes: 8192 },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"ok":true}');
    expect(await readFile(join(state.workspace, "bound.txt"), "utf8")).toBe("immutable baseline");
  });
  it("allows only disposable workspace edits and kills descendants before they can finish a cancelled write", async () => {
    const state = await prepare(true);
    const success = await executeBoundedDshProcess(
      state.sandbox.prepareProcess({
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('/workspace/bound.txt','candidate')"],
        cwd: state.temporary,
        env: {},
      }),
      { timeoutMs: 5000, maxStdoutBytes: 4096, maxStderrBytes: 4096, maxCombinedBytes: 8192 },
    );
    expect(success.exitCode, success.stderr).toBe(0);
    expect(await readFile(join(state.workspace, "bound.txt"), "utf8")).toBe("candidate");
    const late =
      "require('node:child_process').spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('/workspace/late.txt','escaped'),900)\"],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);";
    await expect(
      executeBoundedDshProcess(
        state.sandbox.prepareProcess({
          command: process.execPath,
          args: ["-e", late],
          cwd: state.temporary,
          env: {},
        }),
        { timeoutMs: 150, maxStdoutBytes: 4096, maxStderrBytes: 4096, maxCombinedBytes: 8192 },
      ),
    ).rejects.toThrow();
    await delay(1200);
    await expect(readFile(join(state.workspace, "late.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
