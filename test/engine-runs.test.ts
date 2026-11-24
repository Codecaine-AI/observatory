import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureKernelObservabilitySchema,
  openKernelDatabase,
  traceBlobs,
} from "@codecaine-ai/agent-kernel-db";

import { createObservatoryApp, type ObservatoryApp } from "../src/server/app";
import { engineRunSettingsFromEnv } from "../src/server/engine-runs";
import type { LoadedRegistry } from "../src/server/registry";

const directories: string[] = [];
const apps: ObservatoryApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function archonHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "observatory-archon-"));
  directories.push(directory);
  return directory;
}

const RUN_ID = "11111111-2222-4333-8444-555555555555";

/** An archon.db with one run of one script node: the 2 tables the read service reads. */
function writeArchonDb(home: string): void {
  const db = new Database(join(home, "archon.db"));
  db.run(`CREATE TABLE remote_agent_workflow_runs (
    id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, started_at TEXT, completed_at TEXT, metadata TEXT)`);
  db.run(`CREATE TABLE remote_agent_workflow_events (
    workflow_run_id TEXT, event_type TEXT, step_name TEXT, data TEXT, created_at TEXT, event_order INTEGER)`);
  db.run(
    "INSERT INTO remote_agent_workflow_runs VALUES (?, 'fixture-flow', 'completed', '2026-11-17 10:00:00', '2026-11-17 10:00:05', '{}')",
    [RUN_ID],
  );
  const node = (status: string, order: number) =>
    JSON.stringify({
      node: { id: "prepare", kind: "script" },
      type: "script",
      invocation: { id: "inv-1" },
      attempt: { id: "att-1" },
      timing: { startedAt: "2026-11-17T10:00:01.000Z", durationMs: 1000 },
      ...(status === "node_completed" ? { node_output: "ready" } : {}),
      order,
    });
  db.run("INSERT INTO remote_agent_workflow_events VALUES (?, 'node_started', 'prepare', ?, '2026-11-17 10:00:01', 1)", [RUN_ID, node("node_started", 1)]);
  db.run("INSERT INTO remote_agent_workflow_events VALUES (?, 'node_completed', 'prepare', ?, '2026-11-17 10:00:02', 2)", [RUN_ID, node("node_completed", 2)]);
  db.close();
}

function buildApp(home: string): ObservatoryApp {
  const registry: LoadedRegistry = { path: join(home, "registry.json"), directory: home, registryVersion: 1, projects: [] };
  const observatory = createObservatoryApp(registry, {
    startLiveness: false,
    autoLaunch: false,
    engineRuns: { archonHome: home, gateway: null },
  });
  apps.push(observatory);
  return observatory;
}

const get = (app: ObservatoryApp, path: string) => app.app.handle(new Request(`http://observatory${path}`));

describe("engine run settings", () => {
  test("read the Archon home from OBSERVATORY_ARCHON_HOME, else ~/.archon", () => {
    expect(engineRunSettingsFromEnv({}).archonHome).toBe(join(homedir(), ".archon"));
    expect(engineRunSettingsFromEnv({ OBSERVATORY_ARCHON_HOME: "/data/archon" }).archonHome).toBe("/data/archon");
  });

  test("read the time zone of the Archon schedules from OBSERVATORY_HOST_TIME_ZONE, and refuse a name that is not one", () => {
    expect(engineRunSettingsFromEnv({}).hostTimeZone).toBeUndefined();
    expect(engineRunSettingsFromEnv({ OBSERVATORY_HOST_TIME_ZONE: "America/Chicago" }).hostTimeZone).toBe("America/Chicago");
    expect(() => engineRunSettingsFromEnv({ OBSERVATORY_HOST_TIME_ZONE: "Mars/Olympus" })).toThrow("OBSERVATORY_HOST_TIME_ZONE");
  });

  test.each([
    [{}, 256 * 1024 * 1024],
    [{ OBSERVATORY_BLOCK_CACHE_MB: "64" }, 64 * 1024 * 1024],
    [{ OBSERVATORY_BLOCK_CACHE_MB: "0" }, 0],
  ])("give the call block cache the budget of %j", (env, bytes) => {
    expect(engineRunSettingsFromEnv(env).blockCacheBytes).toBe(bytes);
  });

  test.each(["-1", "1.5", "lots", "70000"])("refuse a block cache budget of %s", (value) => {
    expect(() => engineRunSettingsFromEnv({ OBSERVATORY_BLOCK_CACHE_MB: value })).toThrow("OBSERVATORY_BLOCK_CACHE_MB");
  });

  test("leave the gateway out without a password, and use the traces-sql defaults with one", () => {
    expect(engineRunSettingsFromEnv({ TRACES_SQL_URL: "https://example.test/" }).gateway).toBeNull();
    expect(engineRunSettingsFromEnv({ TRACES_SQL_PASSWORD: "test-only" }).gateway).toEqual({
      url: "https://traces-sql.lascari.dev/",
      user: "traces_ro",
      password: "test-only",
    });
    expect(
      engineRunSettingsFromEnv({ TRACES_SQL_PASSWORD: "test-only", TRACES_SQL_URL: "https://example.test/", TRACES_SQL_USER: "reader" }).gateway,
    ).toMatchObject({ url: "https://example.test/", user: "reader" });
  });
});

describe("engine run routes", () => {
  test("list the runs of the Archon home and serve one run as a tree, with no calls and no gateway", async () => {
    const home = archonHome();
    writeArchonDb(home);
    const observatory = buildApp(home);

    const list = await get(observatory, "/api/engine-runs");
    expect(await list.json()).toEqual({
      engine_runs: [
        {
          engine: "archon",
          runId: RUN_ID,
          workflowName: "fixture-flow",
          status: "completed",
          startedAt: "2026-11-17T10:00:00Z",
          endedAt: "2026-11-17T10:00:05Z",
        },
      ],
    });

    const run = (await (await get(observatory, `/api/engine-runs/archon/${RUN_ID}`)).json()) as {
      spans: { title: string; children: { title: string; attributes: { key: string }[] }[] }[];
    };
    const [root] = run.spans;
    expect(root!.title).toBe("fixture-flow");
    expect(root!.children.map((child) => child.title)).toEqual(["prepare"]);
    // No call store answered, so the node holds no call count.
    expect(root!.children[0]!.attributes.map((attr) => attr.key)).not.toContain("call_count");

    const call = await get(observatory, `/api/engine-runs/archon/${RUN_ID}/calls/00000000-0000-4000-8000-000000000000`);
    expect(call.status).toBe(501);
  });

  test("answer an empty list for an Archon home with no database", async () => {
    const observatory = buildApp(archonHome());
    expect(await (await get(observatory, "/api/engine-runs")).json()).toEqual({ engine_runs: [] });
    expect((await get(observatory, `/api/engine-runs/archon/${RUN_ID}`)).status).toBe(404);
    expect((await get(observatory, "/api/archon-home/kernel/blobs/missing")).status).toBe(404);
  });

  test("serve the blobs of the home's kernel trace.db for the kernel spans of a run", async () => {
    const home = archonHome();
    mkdirSync(join(home, ".agent-kernel"));
    const writer = openKernelDatabase({ path: join(home, ".agent-kernel", "trace.db") });
    await ensureKernelObservabilitySchema(writer.db);
    const hash = `b1-${"c".repeat(64)}`;
    await writer.db.insert(traceBlobs).values({
      hash,
      kind: "text",
      mimeType: "text/plain",
      byteLength: 6,
      data: Buffer.from("kernel"),
      createdAt: "2026-11-17T10:00:00.000Z",
    });
    writer.close();

    const response = await get(buildApp(home), `/api/archon-home/kernel/blobs/${hash}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("kernel");
  });
});
