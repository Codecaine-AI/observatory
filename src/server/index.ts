import { resolve } from "node:path";

import { createObservatoryApp } from "./app";
import { loadRegistry } from "./registry";

const port = Number(Bun.env.OBSERVATORY_API_PORT ?? Bun.env.PORT ?? 4890);
const registryPath = resolve(
  Bun.env.OBSERVATORY_REGISTRY_PATH ?? "registry.json",
);
const registry = await loadRegistry(registryPath);
const observatory = createObservatoryApp(registry);

observatory.app.listen({ hostname: "127.0.0.1", port });

let shutdownStarted = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await observatory.close();
  await observatory.app.stop();
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown(0);
});
process.once("SIGTERM", () => {
  void shutdown(0);
});

console.log(`Observatory API listening on http://127.0.0.1:${port}`);
console.log(`Registry: ${registry.path}`);

export { observatory };
