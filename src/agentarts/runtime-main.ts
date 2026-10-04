import { createAgentArtsServer } from "./server.js";
if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("Runtime requires Linux root supervisor; DSH runs under UID/GID 10001");
}
if ((process.env.DEEPSEEK_API_KEY?.length ?? 0) < 8) {
  throw new Error("Configure DEEPSEEK_API_KEY in the trusted Runtime supervisor environment");
}
const server = createAgentArtsServer();
server.listen(8080, "0.0.0.0", () => {
  process.stdout.write(
    JSON.stringify({ event: "runtime.ready", protocolVersion: 1, dshVersion: "0.2.0-rc.2" }) + "\n",
  );
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.cancelActive();
    server.close();
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
