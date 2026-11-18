import { resolve } from "node:path";

import { createObservatoryApp } from "./app";
import { engineRunSettingsFromEnv, observatoryModeFromEnv } from "./engine-runs";
import { loadRegistry, type LoadedRegistry } from "./registry";

const mode = observatoryModeFromEnv();
const port = Number(Bun.env.OBSERVATORY_API_PORT ?? Bun.env.PORT ?? 4890);
const registryPath = resolve(
  Bun.env.OBSERVATORY_REGISTRY_PATH ?? "registry.json",
);
const engineRuns = engineRunSettingsFromEnv();
if (mode === "server" && !engineRuns.gateway) {
  console.error("Server mode needs TRACES_SQL_PASSWORD: its runs come from ClickHouse.");
  process.exit(1);
}
// Server mode reads no registry, so a registry.json on the host launches nothing.
const registry: LoadedRegistry =
  mode === "server"
    ? { path: registryPath, directory: resolve("."), registryVersion: 1, projects: [] }
    : await loadRegistry(registryPath);
const observatory = createObservatoryApp(registry, { engineRuns, mode });

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
console.log(`Mode: ${mode}`);
console.log(mode === "server" ? "Registry: none (server mode)" : `Registry: ${registry.path}`);
console.log(
  mode === "server"
    ? `Runs: ClickHouse. Kernel spans: ${engineRuns.archonHome}`
    : `Archon home: ${engineRuns.archonHome}`,
);
console.log(
  `Gateway calls: ${engineRuns.gateway ? `read from ${engineRuns.gateway.url}` : "off (TRACES_SQL_PASSWORD is not set)"}`,
);

export { observatory };
