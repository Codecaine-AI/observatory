import type { LivenessMonitor } from "./liveness";
import type {
  LoadedRegistry,
  ResolvedRegistryProject,
} from "./registry";

export type ManagedProjectState =
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "exited"
  | "failed";

export interface ManagedProjectStatus {
  state: ManagedProjectState;
  pid?: number;
  exitCode?: number;
  startedAt?: string;
}

export interface ProjectLogs {
  projectId: string;
  lines: string[];
}

export interface ProjectLauncherOptions {
  startTimeoutMs?: number;
  initialPollDelayMs?: number;
  maxPollDelayMs?: number;
  stopGraceMs?: number;
  maxLogLines?: number;
}

export type LauncherErrorCode =
  | "unknown_project"
  | "no_launch_command"
  | "already_live"
  | "already_starting"
  | "not_managed"
  | "closed";

export class LauncherError extends Error {
  constructor(
    readonly code: LauncherErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LauncherError";
  }
}

function spawnLaunchCommand(command: string, cwd: string) {
  const shellCommand =
    process.platform === "win32"
      ? [Bun.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
      : ["/bin/sh", "-c", command];
  const env = { ...process.env };
  // Strip exactly the generic listener controls PORT, HOST, and HOSTNAME so
  // Observatory's own bind settings cannot redirect a supervised harness.
  // Registry commands should set a project-specific variable or an inline
  // assignment when they need to override a harness's default listener.
  for (const name of ["PORT", "HOST", "HOSTNAME"] as const) delete env[name];
  return Bun.spawn(shellCommand, {
    cwd,
    detached: true,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

type LauncherProcess = ReturnType<typeof spawnLaunchCommand>;

interface ProjectRecord {
  status: ManagedProjectStatus;
  process: LauncherProcess | null;
  stopping: boolean;
  lines: string[];
}

/**
 * Starts and supervises registered harness processes without ever taking
 * ownership of a process that was already serving the project's health URL.
 *
 * launchCommand is an opaque shell command. It runs in a non-login system
 * shell with cwd set to the directory containing registry.json, so relative
 * paths use the same base as the registry's other path-like fields.
 */
export class ProjectLauncher {
  readonly #projects = new Map<string, ResolvedRegistryProject>();
  readonly #records = new Map<string, ProjectRecord>();
  readonly #registryDirectory: string;
  readonly #liveness: LivenessMonitor;
  readonly #startTimeoutMs: number;
  readonly #initialPollDelayMs: number;
  readonly #maxPollDelayMs: number;
  readonly #stopGraceMs: number;
  readonly #maxLogLines: number;
  #closed = false;
  #stopAllPromise: Promise<void> | null = null;

  constructor(
    registry: LoadedRegistry,
    liveness: LivenessMonitor,
    options: ProjectLauncherOptions = {},
  ) {
    this.#registryDirectory = registry.directory;
    this.#liveness = liveness;
    this.#startTimeoutMs = options.startTimeoutMs ?? 15_000;
    this.#initialPollDelayMs = options.initialPollDelayMs ?? 100;
    this.#maxPollDelayMs = options.maxPollDelayMs ?? 1_000;
    this.#stopGraceMs = options.stopGraceMs ?? 2_000;
    this.#maxLogLines = options.maxLogLines ?? 200;

    for (const project of registry.projects) {
      this.#projects.set(project.id, project);
      this.#records.set(project.id, {
        status: { state: "idle" },
        process: null,
        stopping: false,
        lines: [],
      });
    }
  }

  status(projectId: string): ManagedProjectStatus {
    const record = this.#records.get(projectId);
    return record ? { ...record.status } : { state: "idle" };
  }

  logs(projectId: string): ProjectLogs {
    const record = this.#record(projectId);
    return { projectId, lines: [...record.lines] };
  }

  owns(projectId: string): boolean {
    return this.#records.get(projectId)?.process != null;
  }

  async start(projectId: string): Promise<ManagedProjectStatus> {
    if (this.#closed) {
      throw new LauncherError("closed", "Project launcher is closed");
    }
    const project = this.#project(projectId);
    const record = this.#record(projectId);
    if (!project.launchCommand) {
      throw new LauncherError(
        "no_launch_command",
        `Registry project ${projectId} has no launchCommand`,
      );
    }
    if (record.status.state === "starting") {
      throw new LauncherError(
        "already_starting",
        `Registry project ${projectId} is already starting`,
      );
    }
    if (record.process) {
      throw new LauncherError(
        "already_live",
        `Registry project ${projectId} is already managed by Observatory`,
      );
    }
    if (this.#liveness.state(projectId).live) {
      throw new LauncherError(
        "already_live",
        `Registry project ${projectId} is already live outside Observatory`,
      );
    }

    // Mark before the preflight probe so concurrent requests cannot both spawn.
    record.status = { state: "starting" };
    const preflight = await this.#liveness.probe(project);
    if (preflight.live) {
      record.status = { state: "idle" };
      throw new LauncherError(
        "already_live",
        `Registry project ${projectId} is already live outside Observatory`,
      );
    }
    if (this.#closed) {
      record.status = { state: "idle" };
      throw new LauncherError("closed", "Project launcher is closed");
    }

    record.lines = [];
    record.stopping = false;
    const startedAt = new Date().toISOString();
    let child: LauncherProcess;
    try {
      child = spawnLaunchCommand(project.launchCommand, this.#registryDirectory);
    } catch (error) {
      this.#appendLine(record, "supervisor", `Launch failed: ${String(error)}`);
      record.status = { state: "failed", startedAt };
      return { ...record.status };
    }

    record.process = child;
    record.status = { state: "starting", pid: child.pid, startedAt };
    const stdoutCapture = this.#captureStream(record, "stdout", child.stdout);
    const stderrCapture = this.#captureStream(record, "stderr", child.stderr);
    void this.#watchExit(
      project,
      record,
      child,
      stdoutCapture,
      stderrCapture,
    );
    void this.#waitUntilLive(project, record, child);
    return { ...record.status };
  }

  async stop(projectId: string): Promise<ManagedProjectStatus> {
    this.#project(projectId);
    const record = this.#record(projectId);
    const child = record.process;
    if (!child || record.stopping) {
      throw new LauncherError(
        "not_managed",
        `Registry project ${projectId} is not owned by Observatory`,
      );
    }

    record.stopping = true;
    await this.#terminate(child);
    if (record.process === child) record.process = null;
    record.stopping = false;
    record.status = {
      state: "stopped",
      startedAt: record.status.startedAt,
    };
    this.#liveness.markOffline(projectId);
    return { ...record.status };
  }

  autoLaunch(): void {
    for (const project of this.#projects.values()) {
      if (!project.autoLaunch) continue;
      void this.start(project.id).catch((error: unknown) => {
        // An already-live harness is the expected no-double-launch path.
        if (error instanceof LauncherError && error.code === "already_live") {
          return;
        }
        const record = this.#record(project.id);
        this.#appendLine(
          record,
          "supervisor",
          `Auto-launch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        record.status = {
          state: "failed",
          startedAt: record.status.startedAt,
        };
      });
    }
  }

  async stopAll(): Promise<void> {
    if (this.#stopAllPromise) return this.#stopAllPromise;
    this.#closed = true;
    this.#stopAllPromise = (async () => {
      const stops: Promise<unknown>[] = [];
      for (const [projectId, record] of this.#records) {
        if (!record.process) continue;
        if (record.stopping) {
          stops.push(record.process.exited);
          continue;
        }
        stops.push(this.stop(projectId));
      }
      await Promise.allSettled(stops);
    })();
    return this.#stopAllPromise;
  }

  #project(projectId: string): ResolvedRegistryProject {
    const project = this.#projects.get(projectId);
    if (!project) {
      throw new LauncherError(
        "unknown_project",
        `Registry project ${projectId} not found`,
      );
    }
    return project;
  }

  #record(projectId: string): ProjectRecord {
    const record = this.#records.get(projectId);
    if (!record) {
      throw new LauncherError(
        "unknown_project",
        `Registry project ${projectId} not found`,
      );
    }
    return record;
  }

  async #captureStream(
    record: ProjectRecord,
    source: "stdout" | "stderr",
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) this.#appendLine(record, source, line);
      }
      pending += decoder.decode();
      if (pending.length > 0) this.#appendLine(record, source, pending);
    } catch (error) {
      this.#appendLine(record, "supervisor", `Log capture failed: ${String(error)}`);
    } finally {
      reader.releaseLock();
    }
  }

  #appendLine(
    record: ProjectRecord,
    source: "stdout" | "stderr" | "supervisor",
    line: string,
  ): void {
    record.lines.push(`[${source}] ${line}`);
    if (record.lines.length > this.#maxLogLines) {
      record.lines.splice(0, record.lines.length - this.#maxLogLines);
    }
  }

  async #watchExit(
    project: ResolvedRegistryProject,
    record: ProjectRecord,
    child: LauncherProcess,
    stdoutCapture: Promise<void>,
    stderrCapture: Promise<void>,
  ): Promise<void> {
    const exitCode = await child.exited;
    await Promise.allSettled([stdoutCapture, stderrCapture]);
    if (record.process !== child || record.stopping) return;
    record.process = null;
    record.status = {
      state: "exited",
      exitCode,
      startedAt: record.status.startedAt,
    };
    this.#liveness.markOffline(project.id);
  }

  async #waitUntilLive(
    project: ResolvedRegistryProject,
    record: ProjectRecord,
    child: LauncherProcess,
  ): Promise<void> {
    const deadline = Date.now() + this.#startTimeoutMs;
    let delayMs = this.#initialPollDelayMs;

    while (
      Date.now() < deadline
      && record.process === child
      && record.status.state === "starting"
    ) {
      await sleep(delayMs);
      if (record.process !== child || record.status.state !== "starting") return;
      const state = await this.#liveness.probe(project);
      if (record.process !== child || record.status.state !== "starting") return;
      if (state.live) {
        record.status = {
          state: "running",
          pid: child.pid,
          startedAt: record.status.startedAt,
        };
        return;
      }
      delayMs = Math.min(delayMs * 2, this.#maxPollDelayMs);
    }

    if (record.process !== child || record.status.state !== "starting") return;
    this.#appendLine(
      record,
      "supervisor",
      `Harness did not become live within ${this.#startTimeoutMs}ms`,
    );
    record.status = {
      state: "failed",
      startedAt: record.status.startedAt,
    };
    record.stopping = true;
    await this.#terminate(child);
    if (record.process === child) record.process = null;
    record.stopping = false;
    record.status = {
      state: "failed",
      startedAt: record.status.startedAt,
    };
  }

  async #terminate(child: LauncherProcess): Promise<void> {
    if (child.exitCode !== null) return;
    signalOwnedProcessGroup(child, "SIGTERM");
    const exited = await waitForExit(child, this.#stopGraceMs);
    if (!exited && child.exitCode === null) {
      signalOwnedProcessGroup(child, "SIGKILL");
      await child.exited;
    }
  }
}

function signalOwnedProcessGroup(
  child: LauncherProcess,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(
  child: LauncherProcess,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const exited = child.exited.then(() => true as const);
  const result = await Promise.race([exited, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
