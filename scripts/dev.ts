import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const apiPort = String(Bun.env.PORT ?? "4890");
const uiPort = String(Bun.env.FRONTEND_PORT ?? "4891");

const api = Bun.spawn(["bun", "run", "api"], {
  cwd: repoRoot,
  env: {
    ...Bun.env,
    PORT: apiPort,
  },
  stdout: "inherit",
  stderr: "inherit",
});

const ui = Bun.spawn(["bun", "run", "ui"], {
  cwd: repoRoot,
  env: {
    ...Bun.env,
    FRONTEND_PORT: uiPort,
    API_TARGET: `http://127.0.0.1:${apiPort}`,
  },
  stdout: "inherit",
  stderr: "inherit",
});

console.log("\nObservatory");
console.log(`  UI:  http://127.0.0.1:${uiPort}`);
console.log(`  API: http://127.0.0.1:${apiPort}/registry/projects\n`);

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  api.kill();
  ui.kill();
}

process.once("SIGINT", () => {
  shutdown();
  process.exit(130);
});

process.once("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

process.once("exit", shutdown);

const exitCode = await Promise.race([api.exited, ui.exited]);
shutdown();
await Promise.allSettled([api.exited, ui.exited]);
process.exit(exitCode);
