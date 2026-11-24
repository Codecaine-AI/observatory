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
import { limitConcurrency, MAX_CLICKHOUSE_QUERIES } from "./query-limit";
import {
  DEFAULT_BLOCK_CACHE_BYTES,
  createArchonHomeReader,
  createArchonWorkflowCatalog,
  createBlockCache,
  createClickHouseReader,
  createEngineRunRoutes,
  createSessionReader,
  createSessionRoutes,
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
 *
 * Server mode also serves the 10 Session routes of the read service, read from
 * the same ClickHouse with the same read-only user:
 *
 *   GET /api/sessions                  the Session list, last active first, with a search
 *   GET /api/sessions/:sessionId/tree  one Session as a tree
 *   GET /api/node-calls?kind=&id=      100 calls of one node, with their summaries and child
 *                                      nodes: the first ones, or after, from or before a
 *                                      cursor, or around one call (&call=)
 *   GET /api/calls/:callId             the content of one call; ?recent=N for the newest
 *                                      N messages and the answer first
 *   GET /api/calls/:callId/messages?from=&to=
 *                                      the older history of a call
 *   GET /api/orphans                   the nodes with no parent whose subtree has calls
 *   GET /api/unlinked-calls            the calls with no node, grouped by cause
 *   GET /api/engine-runs/:engine/:runId/session
 *                                      the run node of a run and its Session
 *   GET /api/status                    the age of each source
 *   GET /api/workflows                 the workflow runs by workflow, each with its domain,
 *                                      description and Archon binding
 *   GET /api/workflows/:name/source    the YAML of one workflow from a captured source
 *
 * The workflow facts come from the Archon home: the bindings of
 * `<archonHome>/triggers`, and the YAML of the captured source that each
 * run's record names, found through the home's archon.db, or through the
 * run rows in ClickHouse when the home has no archon.db. The captured
 * sources are folders of this host, so a workflow that ran on another host
 * has no description and no YAML.
 *
 * The call reads of both route sets share 1 block cache, with the byte budget
 * of OBSERVATORY_BLOCK_CACHE_MB.
 */

/** The prefix the viewer appends `/engine-runs/...` to. The Session routes share it. */
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
  /** The byte budget of the call block cache. Default `DEFAULT_BLOCK_CACHE_BYTES` (256 MiB); 0 turns it off. */
  blockCacheBytes?: number;
}

const MIB = 1024 * 1024;

/** OBSERVATORY_BLOCK_CACHE_MB: the budget in MiB, a whole number from 0 to 65536. Unset means the default. */
export function blockCacheBytesFromEnv(env: Env = Bun.env): number {
  const value = env.OBSERVATORY_BLOCK_CACHE_MB?.trim() ?? "";
  if (value === "") return DEFAULT_BLOCK_CACHE_BYTES;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_536) {
    throw new Error(`OBSERVATORY_BLOCK_CACHE_MB must be a whole number from 0 to 65536, not ${JSON.stringify(value)}`);
  }
  return Number(value) * MIB;
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
 *   OBSERVATORY_BLOCK_CACHE_MB
 *                            the budget of the call block cache in MiB, default 256; 0 turns it off
 */
export function engineRunSettingsFromEnv(env: Env = Bun.env): EngineRunSettings {
  const home = env.OBSERVATORY_ARCHON_HOME?.trim();
  const password = env.TRACES_SQL_PASSWORD ?? "";
  return {
    archonHome: home ? resolve(home) : join(homedir(), ".archon"),
    blockCacheBytes: blockCacheBytesFromEnv(env),
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
 * The engine run routes and the home's kernel trace routes, as Elysia plugins,
 * and in server mode the Session routes. `sessions` is null in local mode.
 * Server mode throws without a gateway, because its runs come from ClickHouse.
 */
export function createEngineRunPlugins(
  settings: EngineRunSettings,
  kernelDatabase: ArchonKernelDatabase,
  mode: ObservatoryMode = "local",
) {
  // Every reader shares one queue, so the process never runs more ClickHouse queries than the user may,
  // and one block cache, so a call that one route read is cached for the other.
  const gateway = settings.gateway
    ? {
        ...settings.gateway,
        fetch: limitConcurrency(settings.gateway.fetch ?? fetch, MAX_CLICKHOUSE_QUERIES),
        blockCache: settings.gateway.blockCache ?? createBlockCache(settings.blockCacheBytes ?? DEFAULT_BLOCK_CACHE_BYTES),
      }
    : null;
  let reader;
  let sessions = null;
  if (mode === "server") {
    if (!gateway) throw new Error("Server mode needs TRACES_SQL_PASSWORD: its runs come from ClickHouse");
    reader = createClickHouseReader(gateway, { kernelDbPath: kernelDatabase.dbPath });
    const workflowCatalog = createArchonWorkflowCatalog(settings.archonHome, { clickhouse: gateway });
    sessions = createSessionRoutes(createSessionReader({ ...gateway, workflowCatalog }), { prefix: ENGINE_RUNS_API_PREFIX });
  } else {
    reader = createArchonHomeReader(settings.archonHome, gateway ? { gateway } : {});
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
    sessions,
  };
}
