import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createObservatoryApp, type ObservatoryApp } from "../src/server/app";
import { observatoryModeFromEnv } from "../src/server/engine-runs";
import type { LoadedRegistry, ResolvedRegistryProject } from "../src/server/registry";

const directories: string[] = [];
const apps: ObservatoryApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const PROJECT_ID = "harness";

/** A registry with one project that auto-launches, as registry.example.json has. */
function registryWithAutoLaunch(directory: string): LoadedRegistry {
  const project: ResolvedRegistryProject = {
    id: PROJECT_ID,
    name: "Harness",
    kernelId: PROJECT_ID,
    kernelRoot: directory,
    dbPath: join(directory, "trace.db"),
    catalogRoots: [],
    readApiBaseUrl: "http://harness.test",
    viewerBaseUrl: null,
    extensionPackage: null,
    launchCommand: "sleep 30",
    autoLaunch: true,
    writable: true,
    manifest: null,
  };
  return { path: join(directory, "registry.json"), directory, registryVersion: 1, projects: [project] };
}

/** A server-mode app whose ClickHouse holds one Archon run, and every request it makes. */
function serverApp() {
  const directory = mkdtempSync(join(tmpdir(), "observatory-server-mode-"));
  directories.push(directory);
  const projectRequests: string[] = [];
  const clickHouseQueries: string[] = [];
  const observatory = createObservatoryApp(registryWithAutoLaunch(directory), {
    mode: "server",
    fetch: async (input) => {
      projectRequests.push(String(input));
      return new Response("{}");
    },
    engineRuns: {
      archonHome: directory,
      gateway: {
        url: "https://clickhouse.test/",
        user: "reader",
        password: "test-only",
        fetch: async (_input, init) => {
          const sql = String(init?.body);
          clickHouseQueries.push(sql);
          const runLink = { run_id: "run-1", workflow_name: "review", status: "completed", started_at: "2026-11-17 10:00:00.000", completed_at: null };
          return new Response(sql.includes("FROM agents.run_links FINAL\nWHERE engine = 'archon'\nORDER BY") ? `${JSON.stringify(runLink)}\n` : "");
        },
      },
    },
  });
  apps.push(observatory);
  return { observatory, projectRequests, clickHouseQueries };
}

const call = (app: ObservatoryApp, method: string, path: string) =>
  app.app.handle(new Request(`http://observatory${path}`, { method }));

describe("server mode", () => {
  test.each([
    ["POST", `/registry/projects/${PROJECT_ID}/launch`],
    ["POST", `/registry/projects/${PROJECT_ID}/stop`],
    ["GET", `/registry/projects/${PROJECT_ID}/logs`],
    ["GET", `/registry/kernels/${PROJECT_ID}/kernel/containers`],
    ["POST", `/registry/kernels/${PROJECT_ID}/kernel/catalog/agents/a/edit-sessions`],
    ["GET", "/api/actions"],
  ])("answers 404 to %s %s", async (method, path) => {
    const { observatory } = serverApp();

    expect((await call(observatory, method, path)).status).toBe(404);
  });

  test("lists no project, probes none, and launches none, though the registry has an auto-launch project", async () => {
    const { observatory, projectRequests } = serverApp();

    const response = await call(observatory, "GET", "/registry/projects");

    expect(await response.json()).toEqual({ projects: [] });
    expect(projectRequests).toEqual([]);
    // Local mode marks an auto-launch project "starting" before createObservatoryApp returns.
    expect(observatory.launcher.status(PROJECT_ID)).toEqual({ state: "idle" });
    expect(observatory.launcher.start(PROJECT_ID)).rejects.toThrow("not found");
  });

  test("reads the run list from ClickHouse", async () => {
    const { observatory, clickHouseQueries } = serverApp();

    const response = await call(observatory, "GET", "/api/engine-runs");

    expect(await response.json()).toEqual({
      engine_runs: [
        { engine: "archon", runId: "run-1", workflowName: "review", status: "completed", startedAt: "2026-11-17T10:00:00Z", endedAt: null },
      ],
    });
    expect(clickHouseQueries).toHaveLength(1);
  });

  test("refuses to start with no ClickHouse password", () => {
    const directory = mkdtempSync(join(tmpdir(), "observatory-server-mode-"));
    directories.push(directory);

    expect(() =>
      createObservatoryApp(registryWithAutoLaunch(directory), {
        mode: "server",
        startLiveness: false,
        autoLaunch: false,
        engineRuns: { archonHome: directory, gateway: null },
      }),
    ).toThrow("TRACES_SQL_PASSWORD");
  });
});

describe("OBSERVATORY_MODE", () => {
  test.each([
    [undefined, "local"],
    ["", "local"],
    ["local", "local"],
    ["server", "server"],
    [" server ", "server"],
  ])("%p gives %p", (value, mode) => {
    expect(observatoryModeFromEnv({ OBSERVATORY_MODE: value })).toBe(mode as "local" | "server");
  });

  test("throws on any other value", () => {
    expect(() => observatoryModeFromEnv({ OBSERVATORY_MODE: "prod" })).toThrow("local or server");
  });
});
