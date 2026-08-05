import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createObservatoryApp, type ObservatoryApp } from "../src/server/app";
import type { FetchLike } from "../src/server/liveness";
import type {
  LoadedRegistry,
  ResolvedRegistryProject,
} from "../src/server/registry";

const temporaryDirectories: string[] = [];
const openApps: ObservatoryApp[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project launcher routes", () => {
  test("auto-launches flagged projects when the app starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "observatory-routes-"));
    temporaryDirectories.push(directory);
    const scriptPath = join(directory, "auto-managed.ts");
    await Bun.write(scriptPath, "setInterval(() => {}, 1000);");
    const entry = project(directory, "auto-managed", {
      autoLaunch: true,
      launchCommand: `bun ${shellQuote(scriptPath)}`,
      readApiBaseUrl: "http://auto-managed.test",
    });
    const observatory = createObservatoryApp(registry(directory, [entry]), {
      fetch: async () => new Response("offline", { status: 503 }),
      startLiveness: false,
      launcher: { startTimeoutMs: 5_000, stopGraceMs: 100 },
    });
    openApps.push(observatory);

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && observatory.launcher.status(entry.id).pid === undefined) {
      await Bun.sleep(10);
    }
    expect(observatory.launcher.status(entry.id)).toMatchObject({
      state: "starting",
      pid: expect.any(Number),
    });
  });

  test("returns lifecycle statuses and exposes managed state and logs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "observatory-routes-"));
    temporaryDirectories.push(directory);
    const scriptPath = join(directory, "managed.ts");
    await Bun.write(
      scriptPath,
      `
        console.log("managed route fixture");
        setInterval(() => {}, 1000);
      `,
    );

    const projects = [
      project(directory, "managed", {
        launchCommand: `bun ${shellQuote(scriptPath)}`,
        readApiBaseUrl: "http://managed.test",
      }),
      project(directory, "live", {
        launchCommand: `bun ${shellQuote(scriptPath)}`,
        readApiBaseUrl: "http://live.test",
      }),
      project(directory, "no-command", {
        launchCommand: null,
        readApiBaseUrl: "http://offline.test",
      }),
    ];
    const fetchMock: FetchLike = async (input) =>
      String(input).startsWith("http://live.test")
        ? Response.json({ status: "ok" })
        : new Response("offline", { status: 503 });
    const observatory = createObservatoryApp(
      registry(directory, projects),
      {
        fetch: fetchMock,
        startLiveness: false,
        autoLaunch: false,
        launcher: {
          startTimeoutMs: 5_000,
          initialPollDelayMs: 100,
          maxPollDelayMs: 100,
          stopGraceMs: 100,
        },
      },
    );
    openApps.push(observatory);

    expect(await post(observatory, "/registry/projects/unknown/launch")).toBe(404);
    expect(await post(observatory, "/registry/projects/no-command/launch")).toBe(400);
    expect(await post(observatory, "/registry/projects/live/launch")).toBe(409);

    const firstLaunch = await observatory.app.handle(
      request("/registry/projects/managed/launch", "POST"),
    );
    expect(firstLaunch.status).toBe(202);
    expect(await firstLaunch.json()).toMatchObject({
      managed: { state: "starting", pid: expect.any(Number) },
    });
    expect(await post(observatory, "/registry/projects/managed/launch")).toBe(409);

    const projectsResponse = await observatory.app.handle(
      request("/registry/projects"),
    );
    expect(projectsResponse.status).toBe(200);
    expect(await projectsResponse.json()).toMatchObject({
      projects: [
        {
          id: "managed",
          launchable: true,
          managed: { state: "starting", pid: expect.any(Number) },
        },
        { id: "live", live: true, managed: { state: "idle" } },
        { id: "no-command", launchable: false, managed: { state: "idle" } },
      ],
    });

    await waitForLog(observatory, "managed", "managed route fixture");
    const logsResponse = await observatory.app.handle(
      request("/registry/projects/managed/logs"),
    );
    expect(logsResponse.status).toBe(200);
    expect(await logsResponse.json()).toMatchObject({
      projectId: "managed",
      lines: expect.arrayContaining(["[stdout] managed route fixture"]),
    });
    expect(
      (await observatory.app.handle(request("/registry/projects/unknown/logs"))).status,
    ).toBe(404);

    expect(await post(observatory, "/registry/projects/unknown/stop")).toBe(404);
    expect(await post(observatory, "/registry/projects/live/stop")).toBe(409);
    expect(await post(observatory, "/registry/projects/managed/stop")).toBe(200);
    expect(await post(observatory, "/registry/projects/managed/stop")).toBe(409);
  });
});

function project(
  directory: string,
  id: string,
  overrides: Partial<ResolvedRegistryProject>,
): ResolvedRegistryProject {
  return {
    id,
    name: id,
    kernelId: `${id}-kernel`,
    kernelRoot: join(directory, id, ".agent-kernel"),
    dbPath: join(directory, id, ".agent-kernel", "trace.db"),
    catalogRoots: [],
    readApiBaseUrl: null,
    viewerBaseUrl: null,
    extensionPackage: null,
    launchCommand: null,
    autoLaunch: false,
    writable: true,
    manifest: null,
    ...overrides,
  };
}

function registry(
  directory: string,
  projects: ResolvedRegistryProject[],
): LoadedRegistry {
  return {
    path: join(directory, "registry.json"),
    directory,
    registryVersion: 1,
    projects,
  };
}

async function post(app: ObservatoryApp, path: string): Promise<number> {
  return (await app.app.handle(request(path, "POST"))).status;
}

function request(path: string, method = "GET"): Request {
  return new Request(`http://observatory${path}`, { method });
}

async function waitForLog(
  app: ObservatoryApp,
  projectId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const lines = app.launcher.logs(projectId).lines;
    if (lines.some((line) => line.includes(expected))) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for launcher log: ${expected}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
