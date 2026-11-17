import { resolve } from "node:path";

import { createObservatoryApp } from "./app";
import { engineRunSettingsFromEnv } from "./engine-runs";
import { loadRegistry } from "./registry";

const port = Number(Bun.env.OBSERVATORY_API_PORT ?? Bun.env.PORT ?? 4890);
const registryPath = resolve(
  Bun.env.OBSERVATORY_REGISTRY_PATH ?? "registry.json",
);
const registry = await loadRegistry(registryPath);
const engineRuns = engineRunSettingsFromEnv();
const observatory = createObservatoryApp(registry, { engineRuns });

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
console.log(`Archon home: ${engineRuns.archonHome}`);
console.log(
  `Gateway calls: ${engineRuns.gateway ? `read from ${engineRuns.gateway.url}` : "off (TRACES_SQL_PASSWORD is not set)"}`,
);

export { observatory };
