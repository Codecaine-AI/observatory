import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createObservatoryApp, type ObservatoryApp } from "../src/server/app";
import {
  LauncherError,
  ProjectLauncher,
  type ManagedProjectState,
  type ProjectLauncherOptions,
} from "../src/server/launcher";
import { LivenessMonitor, type FetchLike } from "../src/server/liveness";
import type {
  LoadedRegistry,
  ResolvedRegistryProject,
} from "../src/server/registry";

const temporaryDirectories: string[] = [];
const launchers: ProjectLauncher[] = [];
const openApps: ObservatoryApp[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "observatory-launcher-"));
  temporaryDirectories.push(directory);
  return directory;
}

function project(
  directory: string,
  overrides: Partial<ResolvedRegistryProject> = {},
): ResolvedRegistryProject {
  return {
    id: "fixture",
    name: "Fixture",
    kernelId: "fixture-kernel",
    kernelRoot: join(directory, ".agent-kernel"),
    dbPath: join(directory, ".agent-kernel", "trace.db"),
    catalogRoots: [],
    readApiBaseUrl: "http://127.0.0.1:1",
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

function makeLauncher(
  entry: ResolvedRegistryProject,
  directory: string,
  fetchImpl: FetchLike = globalThis.fetch,
  options: ProjectLauncherOptions = {},
): ProjectLauncher {
  const loaded = registry(directory, [entry]);
  const liveness = new LivenessMonitor(loaded.projects, {
    fetch: fetchImpl,
    timeoutMs: 80,
  });
  const launcher = new ProjectLauncher(loaded, liveness, {
    startTimeoutMs: 2_000,
    initialPollDelayMs: 20,
    maxPollDelayMs: 80,
    stopGraceMs: 250,
    ...options,
  });
  launchers.push(launcher);
  return launcher;
}

afterEach(async () => {
  for (const observatory of openApps.splice(0)) {
    await observatory.close();
    await observatory.app.stop();
  }
  await Promise.all(launchers.splice(0).map((launcher) => launcher.stopAll()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProjectLauncher", () => {
  test("starts a health server, reaches running, and stops its owned process", async () => {
    const directory = makeTemporaryDirectory();
    const port = await reservePort();
    const scriptPath = join(directory, "health-server.ts");
    await Bun.write(
      scriptPath,
      `
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: ${port},
          fetch(request) {
            return new URL(request.url).pathname === "/health"
              ? Response.json({ status: "ok" })
              : new Response("not found", { status: 404 });
          },
        });
        console.log("fixture health server ready");
        process.once("SIGTERM", async () => {
          await server.stop(true);
          process.exit(0);
        });
        await new Promise(() => {});
      `,
    );
    const entry = project(directory, {
      readApiBaseUrl: `http://127.0.0.1:${port}`,
      launchCommand: `bun ${shellQuote(scriptPath)}`,
    });
    const launcher = makeLauncher(entry, directory);

    expect(await launcher.start(entry.id)).toMatchObject({ state: "starting" });
    expect(await waitForState(launcher, entry.id, "running")).toMatchObject({
      state: "running",
      pid: expect.any(Number),
    });

    expect(await launcher.stop(entry.id)).toMatchObject({ state: "stopped" });
    expect(launcher.status(entry.id).pid).toBeUndefined();
    await waitForHealthOffline(entry.readApiBaseUrl!);
  });

  test("detects an exit code and captures stdout, stderr, and launch cwd", async () => {
    const directory = makeTemporaryDirectory();
    const scriptPath = join(directory, "exit.ts");
    await Bun.write(
      scriptPath,
      `
        console.log("stdout line");
        console.log("cwd=" + process.cwd());
        console.error("stderr line");
        process.exit(7);
      `,
    );
    const entry = project(directory, {
      launchCommand: `bun ${shellQuote(scriptPath)}`,
    });
    const launcher = makeLauncher(entry, directory);

    await launcher.start(entry.id);
    expect(await waitForState(launcher, entry.id, "exited")).toMatchObject({
      state: "exited",
      exitCode: 7,
    });
    expect(launcher.logs(entry.id).lines).toEqual(
      expect.arrayContaining([
        "[stdout] stdout line",
        `[stdout] cwd=${realpathSync(directory)}`,
        "[stderr] stderr line",
      ]),
    );
  });

  test("removes Observatory listener variables from the child environment", async () => {
    const directory = makeTemporaryDirectory();
    const scriptPath = join(directory, "print-environment.ts");
    await Bun.write(
      scriptPath,
      `
        for (const name of ["PORT", "HOST", "HOSTNAME", "HARNESS_SENTINEL"]) {
          console.log(name + "=" + (Bun.env[name] ?? "<unset>"));
        }
      `,
    );
    const entry = project(directory, {
      launchCommand: `bun ${shellQuote(scriptPath)}`,
    });
    const launcher = makeLauncher(entry, directory);
    const restoreEnvironment = overrideEnvironment({
      PORT: "4890",
      HOST: "127.0.0.1",
      HOSTNAME: "observatory.test",
      HARNESS_SENTINEL: "preserved",
    });

    try {
      await launcher.start(entry.id);
    } finally {
      restoreEnvironment();
    }

    expect(await waitForState(launcher, entry.id, "exited")).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
    expect(launcher.logs(entry.id).lines).toEqual(
      expect.arrayContaining([
        "[stdout] PORT=<unset>",
        "[stdout] HOST=<unset>",
        "[stdout] HOSTNAME=<unset>",
        "[stdout] HARNESS_SENTINEL=preserved",
      ]),
    );
  });

  test("does not spawn when the harness is already live", async () => {
    const directory = makeTemporaryDirectory();
    const markerPath = join(directory, "spawned.txt");
    const scriptPath = join(directory, "marker.ts");
    await Bun.write(scriptPath, `await Bun.write(${JSON.stringify(markerPath)}, "spawned");`);
    const entry = project(directory, {
      launchCommand: `bun ${shellQuote(scriptPath)}`,
    });
    const fetchMock: FetchLike = async () => Response.json({ status: "ok" });
    const launcher = makeLauncher(entry, directory, fetchMock);

    try {
      await launcher.start(entry.id);
      throw new Error("Expected start to reject an already-live project");
    } catch (error) {
      expect(error).toBeInstanceOf(LauncherError);
      expect((error as LauncherError).code).toBe("already_live");
    }
    expect(launcher.status(entry.id)).toEqual({ state: "idle" });
    expect(existsSync(markerPath)).toBe(false);
  });

  test("times out, captures the log tail, and terminates the failed process", async () => {
    const directory = makeTemporaryDirectory();
    const port = await reservePort();
    const scriptPath = join(directory, "never-live.ts");
    await Bun.write(
      scriptPath,
      `
        console.log("waiting without a health server");
        setInterval(() => {}, 1000);
      `,
    );
    const entry = project(directory, {
      readApiBaseUrl: `http://127.0.0.1:${port}`,
      launchCommand: `bun ${shellQuote(scriptPath)}`,
    });
    const launcher = makeLauncher(entry, directory, globalThis.fetch, {
      startTimeoutMs: 120,
      initialPollDelayMs: 10,
      maxPollDelayMs: 20,
      stopGraceMs: 100,
    });

    await launcher.start(entry.id);
    expect(await waitForState(launcher, entry.id, "failed")).toEqual({
      state: "failed",
      startedAt: expect.any(String),
    });
    expect(launcher.logs(entry.id).lines.join("\n")).toContain(
      "waiting without a health server",
    );
    expect(launcher.logs(entry.id).lines.join("\n")).toContain(
      "did not become live within 120ms",
    );
  });

  test(
    "auto-launches the real Prompt Kit harness on its named port while Observatory keeps its own port",
    async () => {
      const observatoryPort = await reservePort();
      const harnessPort = await reservePort();
      const observatoryRoot = resolve(import.meta.dir, "..");
      const entry = project(observatoryRoot, {
        id: "prompt-kit",
        name: "Prompt Kit",
        kernelId: "prompt-kit-kernel",
        kernelRoot: resolve(
          observatoryRoot,
          "../prompt-kit/packages/prompt-kit-agent/.agent-kernel",
        ),
        catalogRoots: [
          resolve(
            observatoryRoot,
            "../prompt-kit/packages/prompt-kit-agent/catalog",
          ),
        ],
        readApiBaseUrl: `http://127.0.0.1:${harnessPort}`,
        launchCommand: "bun run --cwd ../prompt-kit dev:agent",
        autoLaunch: true,
      });
      const restoreEnvironment = overrideEnvironment({
        PORT: String(observatoryPort),
        PROMPT_KIT_KERNEL_PORT: String(harnessPort),
      });
      let observatory: ObservatoryApp | undefined;

      try {
        observatory = createObservatoryApp(
          registry(observatoryRoot, [entry]),
          {
            startLiveness: false,
            liveness: { timeoutMs: 250 },
            launcher: {
              startTimeoutMs: 10_000,
              initialPollDelayMs: 20,
              maxPollDelayMs: 200,
              stopGraceMs: 1_000,
            },
          },
        );
        openApps.push(observatory);
        observatory.app.listen({ hostname: "127.0.0.1", port: observatoryPort });

        expect(
          await waitForState(observatory.launcher, entry.id, "running", 12_000),
        ).toMatchObject({ state: "running", pid: expect.any(Number) });

        const observatoryHealth = await fetch(
          `http://127.0.0.1:${observatoryPort}/health`,
        );
        expect(observatoryHealth.status).toBe(200);
        expect(await observatoryHealth.json()).toEqual({
          status: "ok",
          projects: 1,
        });

        const projectList = await fetch(
          `http://127.0.0.1:${observatoryPort}/registry/projects`,
        );
        expect(projectList.status).toBe(200);
        expect(await projectList.json()).toMatchObject({
          projects: [{ id: "prompt-kit", live: true }],
        });

        const harnessHealth = await fetch(
          `http://127.0.0.1:${harnessPort}/health`,
        );
        expect(harnessHealth.status).toBe(200);
        expect(await harnessHealth.json()).toEqual({
          status: "ok",
          kernel: "prompt-kit-kernel",
        });
      } finally {
        try {
          if (observatory) {
            await observatory.close();
            await observatory.app.stop();
            const appIndex = openApps.indexOf(observatory);
            if (appIndex >= 0) openApps.splice(appIndex, 1);
          }
        } finally {
          restoreEnvironment();
        }
      }
    },
    15_000,
  );
});

async function reservePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error("Bun did not assign an ephemeral port");
  return port;
}

async function waitForState(
  launcher: ProjectLauncher,
  projectId: string,
  expected: ManagedProjectState,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = launcher.status(projectId);
    if (status.state === expected) return status;
    await Bun.sleep(10);
  }
  throw new Error(
    `Timed out waiting for ${expected}; got ${JSON.stringify(launcher.status(projectId))}\n${launcher.logs(projectId).lines.join("\n")}`,
  );
}

async function waitForHealthOffline(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await fetch(new URL("/health", baseUrl));
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Health endpoint remained online after supervisor stop: ${baseUrl}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function overrideEnvironment(
  overrides: Record<string, string>,
): () => void {
  const previous = new Map(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(overrides)) {
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
