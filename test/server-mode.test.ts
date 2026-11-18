import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARCHON_RUN_ROWS_SQL, RUN_CALLS_SQL } from "@codecaine-ai/agent-kernel-viewer-read-service";

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

const CALL_ID = "0b9d4c55-2f7e-4c1a-9a43-5f0d6c2e8a11";
const SOURCE = { machine: "services-01", file_id: "file-1" };
const nodeData = { node: { id: "review", kind: "agent" }, invocation: { id: "inv-1" }, attempt: { id: "att-1" }, provider: "claude" };
const jsonLines = (rows: object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/** The ClickHouse rows of run-1: its run_links source, its run row, one agent node, and one gateway call. */
function clickHouseAnswer(sql: string): string {
  if (sql.startsWith(ARCHON_RUN_ROWS_SQL)) {
    const runRow = { id: "run-1", workflow_name: "review", status: "completed", started_at: "2026-11-17 10:00:00", completed_at: "2026-11-17 10:00:05", metadata: null };
    const nodeRow = (eventType: string, order: number) => ({
      id: `event-${order}`, event_order: order, event_type: eventType, step_name: "review",
      data: JSON.stringify(nodeData), created_at: "2026-11-17 10:00:01",
    });
    return jsonLines([
      { kind: "source", ...SOURCE, snapshot_table: "", raw: "" },
      { kind: "row", ...SOURCE, snapshot_table: "remote_agent_workflow_runs", raw: JSON.stringify(runRow) },
      { kind: "row", ...SOURCE, snapshot_table: "remote_agent_workflow_events", raw: JSON.stringify(nodeRow("node_started", 1)) },
      { kind: "row", ...SOURCE, snapshot_table: "remote_agent_workflow_events", raw: JSON.stringify(nodeRow("node_completed", 2)) },
    ]);
  }
  if (sql.startsWith(RUN_CALLS_SQL)) {
    return jsonLines([{
      call_id: CALL_ID, response_id: "msg_1", engine: "archon", run_id: "run-1", node_path: "review",
      invocation_id: "inv-1", attempt_id: "att-1", loop_path: "", outcome: "completed", started_at: "2026-11-17 10:00:02.000",
    }]);
  }
  if (sql.includes("FROM agents.run_links FINAL\nWHERE engine = 'archon'\nORDER BY")) {
    return jsonLines([{ run_id: "run-1", workflow_name: "review", status: "completed", started_at: "2026-11-17 10:00:00.000", completed_at: null }]);
  }
  return "";
}

/** A server-mode app whose ClickHouse holds one Archon run, and every request it makes. */
function serverApp() {
  const directory = mkdtempSync(join(tmpdir(), "observatory-server-mode-"));
  directories.push(directory);
  const projectRequests: string[] = [];
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
        fetch: async (_input, init) => new Response(clickHouseAnswer(String(init?.body))),
      },
    },
  });
  apps.push(observatory);
  return { observatory, projectRequests };
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
    await expect(observatory.launcher.start(PROJECT_ID)).rejects.toThrow("not found");
  });

  test("reads the run list from ClickHouse", async () => {
    const { observatory } = serverApp();

    const response = await call(observatory, "GET", "/api/engine-runs");

    expect(await response.json()).toEqual({
      engine_runs: [
        { engine: "archon", runId: "run-1", workflowName: "review", status: "completed", startedAt: "2026-11-17T10:00:00Z", endedAt: null },
      ],
    });
  });

  test("reads one run from ClickHouse, with its call under the node attempt", async () => {
    const { observatory } = serverApp();

    const response = await call(observatory, "GET", "/api/engine-runs/archon/run-1");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { status: string }; spans: { children?: { title: string; children?: { attributes?: { key: string; value: { stringValue?: string } }[] }[] }[] }[] };
    expect(body.run.status).toBe("completed");
    const [attempt] = body.spans[0]!.children!;
    expect(attempt!.title).toBe("review");
    const callIds = attempt!.children!.map((span) => span.attributes?.find((a) => a.key === "call_id")?.value.stringValue);
    expect(callIds).toEqual([CALL_ID]);
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
