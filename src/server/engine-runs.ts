import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  createContainerReadService,
  type KernelReadApiService,
} from "@codecaine-ai/agent-kernel";
import {
  openKernelDatabaseReadOnly,
  type KernelDatabaseHandle,
} from "@codecaine-ai/agent-kernel-db";
import { createKernelTraceReadApi } from "@codecaine-ai/agent-kernel/read-api";
import {
  createArchonHomeReader,
  createClickHouseReader,
  createEngineRunRoutes,
  type GatewayAdapterOptions,
} from "@codecaine-ai/agent-kernel-viewer-read-service";

/**
 * Engine runs: the runs of the workflow engine in one Archon home, read
 * through the trace-viewer read service.
 *
 *   GET /api/engine-runs                              the run list, newest first
 *   GET /api/engine-runs/:engine/:runId               one run as a span tree
 *   GET /api/engine-runs/:engine/:runId/calls/:callId one model call
 *   GET /api/archon-home/kernel/...                   the kernel trace routes on the
 *                                                     home's kernel trace.db
 *
 * The kernel routes serve the blobs and turn contexts that the kernel detail
 * renderers fetch for the kernel spans of a run's kernel nodes.
 *
 * In local mode the runs come from the home's archon.db. In server mode they
 * come from the trace ClickHouse, and the home gives only the kernel spans.
 */

/** The prefix the viewer appends `/engine-runs/...` to. */
export const ENGINE_RUNS_API_PREFIX = "/api";
/** The prefix the viewer appends kernel paths such as `/kernel/blobs/:hash` to. */
export const ARCHON_HOME_KERNEL_PREFIX = "/api/archon-home";

/** The defaults of the `traces-sql` wrapper: its URL and its read-only user. */
const DEFAULT_TRACES_SQL_URL = "https://traces-sql.lascari.dev/";
const DEFAULT_TRACES_SQL_USER = "traces_ro";

export interface EngineRunSettings {
  /** The Archon home: `archon.db` and `.agent-kernel/trace.db`. */
  archonHome: string;
  /** The trace ClickHouse; null when no password is set, so the tree shows no calls. */
  gateway: GatewayAdapterOptions | null;
}

type Env = Record<string, string | undefined>;

/**
 * local   the Observatory of one machine: the registry, the launcher, and the
 *         runs of the local Archon home
 * server  a shared host: read-only routes, and the runs from ClickHouse
 */
export type ObservatoryMode = "local" | "server";

/** OBSERVATORY_MODE: `server`, or `local` when unset. Any other value throws. */
export function observatoryModeFromEnv(env: Env = Bun.env): ObservatoryMode {
  const value = env.OBSERVATORY_MODE?.trim() ?? "";
  if (value === "" || value === "local") return "local";
  if (value === "server") return "server";
  throw new Error(`OBSERVATORY_MODE must be local or server, not ${JSON.stringify(value)}`);
}

/**
 * Reads the settings from the environment:
 *   OBSERVATORY_ARCHON_HOME  the Archon home (default ~/.archon)
 *   TRACES_SQL_PASSWORD      the read-only ClickHouse password; unset means no calls
 *   TRACES_SQL_URL           default https://traces-sql.lascari.dev/
 *   TRACES_SQL_USER          default traces_ro
 */
export function engineRunSettingsFromEnv(env: Env = Bun.env): EngineRunSettings {
  const home = env.OBSERVATORY_ARCHON_HOME?.trim();
  const password = env.TRACES_SQL_PASSWORD ?? "";
  return {
    archonHome: home ? resolve(home) : join(homedir(), ".archon"),
    gateway:
      password === ""
        ? null
        : {
            url: env.TRACES_SQL_URL?.trim() || DEFAULT_TRACES_SQL_URL,
            user: env.TRACES_SQL_USER?.trim() || DEFAULT_TRACES_SQL_USER,
            password,
          },
  };
}

/** The kernel trace.db of the Archon home, opened read-only on first use. */
export class ArchonKernelDatabase {
  readonly dbPath: string;
  #handle: KernelDatabaseHandle | null = null;
  #service: KernelReadApiService | null = null;

  constructor(archonHome: string) {
    this.dbPath = join(archonHome, ".agent-kernel", "trace.db");
  }

  service(): KernelReadApiService | null {
    if (this.#service) return this.#service;
    if (!existsSync(this.dbPath)) return null;
    this.#handle = openKernelDatabaseReadOnly(this.dbPath);
    this.#service = createContainerReadService({ db: this.#handle.db });
    return this.#service;
  }

  close(): void {
    this.#handle?.close();
    this.#handle = null;
    this.#service = null;
  }
}

/**
 * The engine run routes and the home's kernel trace routes, as Elysia plugins.
 * Server mode throws without a gateway, because its runs come from ClickHouse.
 */
export function createEngineRunPlugins(
  settings: EngineRunSettings,
  kernelDatabase: ArchonKernelDatabase,
  mode: ObservatoryMode = "local",
) {
  let reader;
  if (mode === "server") {
    if (!settings.gateway) throw new Error("Server mode needs TRACES_SQL_PASSWORD: its runs come from ClickHouse");
    reader = createClickHouseReader(settings.gateway, { kernelDbPath: kernelDatabase.dbPath });
  } else {
    reader = createArchonHomeReader(
      settings.archonHome,
      settings.gateway ? { gateway: settings.gateway } : {},
    );
  }
  const service = () => kernelDatabase.service();
  const kernelApi = createKernelTraceReadApi(
    {
      async getContainerTrace(containerId, query) {
        return (await service()?.getContainerTrace(containerId, query)) ?? null;
      },
      async listSessionContainers(query) {
        return (
          (await service()?.listSessionContainers?.(query)) ?? {
            trace_sessions: [],
          }
        );
      },
      async getBlob(hash) {
        return (await service()?.getBlob?.(hash)) ?? null;
      },
      async getRunTurnContext(runId, turnNumber) {
        return (await service()?.getRunTurnContext?.(runId, turnNumber)) ?? null;
      },
    },
    { prefix: `${ARCHON_HOME_KERNEL_PREFIX}/kernel` },
  );
  return {
    engineRuns: createEngineRunRoutes(reader, { prefix: ENGINE_RUNS_API_PREFIX }),
    kernelApi,
  };
}
