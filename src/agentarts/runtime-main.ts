import { createAgentArtsServer, runtimeProtocolVersions } from "./server.js";
import { assertAgentArtsRuntimeIsolation } from "./worker.js";
import { supervisorEnvironment } from "./supervisor-secrets.js";
if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("Runtime requires Linux root supervisor; DSH runs under UID/GID 10001");
}
async function main(): Promise<void> {
  await assertAgentArtsRuntimeIsolation();
  const environment = await supervisorEnvironment(process.env);
  const inboundMode = environment.AGENTARTS_INBOUND_MODE ?? "platform";
  if (inboundMode !== "platform" && inboundMode !== "local")
    throw new Error("Invalid Runtime inbound mode");
  if (inboundMode === "local" && environment.AGENTARTS_LOCAL_API_KEY === undefined)
    throw new Error("Direct local Runtime access requires an independent local API capability");
  const server = createAgentArtsServer({ environment });
  const bindHost = environment.AGENTARTS_BIND_HOST ?? "0.0.0.0";
  if (bindHost !== "0.0.0.0" && bindHost !== "127.0.0.1")
    throw new Error("Invalid trusted Runtime bind host");
  server.listen(8080, bindHost, () => {
    process.stdout.write(
      JSON.stringify({
        event: "runtime.ready",
        protocolVersions: runtimeProtocolVersions(environment),
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
