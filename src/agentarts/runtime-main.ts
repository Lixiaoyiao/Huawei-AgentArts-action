import { createAgentArtsServer } from "./server.js";
import { assertAgentArtsRuntimeIsolation } from "./worker.js";
import { supervisorEnvironment } from "./supervisor-secrets.js";
if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("Runtime requires Linux root supervisor; DSH runs under UID/GID 10001");
}
async function main(): Promise<void> {
  await assertAgentArtsRuntimeIsolation();
  const environment = await supervisorEnvironment(process.env);
  const server = createAgentArtsServer({ environment });
  server.listen(8080, "0.0.0.0", () => {
    process.stdout.write(
      JSON.stringify({
        event: "runtime.ready",
        protocolVersions: [1, 2],
        dshVersion: "0.2.0-rc.2",
      }) + "\n",
    );
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      server.cancelActive();
      server.close();
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
}
void main().catch(() => {
  process.stderr.write(
    "Runtime startup refused: verify supervisor isolation, secret configuration and model policy. Values were not logged.\n",
  );
  process.exitCode = 1;
});
