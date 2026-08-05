import { Elysia } from "elysia";

import {
  createKernelTraceReadApi,
  type KernelTraceReadQuery,
} from "@agent-kernel/kernel/read-api";

import { ProjectDatabaseManager } from "./database";
import {
  LivenessMonitor,
  type FetchLike,
  type LivenessMonitorOptions,
} from "./liveness";
import {
  LauncherError,
  ProjectLauncher,
  type ProjectLauncherOptions,
} from "./launcher";
import { proxyKernelRequest } from "./proxy";
import type {
  LoadedRegistry,
  ResolvedRegistryProject,
} from "./registry";

export interface CreateObservatoryAppOptions {
  fetch?: FetchLike;
  liveness?: Omit<LivenessMonitorOptions, "fetch">;
  launcher?: ProjectLauncherOptions;
  startLiveness?: boolean;
  autoLaunch?: boolean;
}

export interface ObservatoryApp {
  app: {
    handle(request: Request): Promise<Response>;
    listen(options: { hostname: string; port: number }): unknown;
    stop(): Promise<unknown>;
  };
  liveness: LivenessMonitor;
  launcher: ProjectLauncher;
  databases: ProjectDatabaseManager;
  close(): Promise<void>;
}

/**
 * Kernel paths whose mutations are gated on the registry `writable` flag.
 *
 * `catalog/**` covers prompt saves, annotation CRUD, and edit-session
 * creation (`catalog/agents/:name/edit-sessions`). `prompt-edit-sessions/**`
 * covers driving an existing session (requests, accept/reject/undo). Reads —
 * including the session SSE stream — stay available for any live project.
 */
function isWriteGatedKernelPath(path: string): boolean {
  return (
    path.startsWith("catalog/")
    || path === "prompt-edit-sessions"
    || path.startsWith("prompt-edit-sessions/")
  );
}

function missingDatabaseService(
  databases: ProjectDatabaseManager,
  project: ResolvedRegistryProject,
) {
  const queryService = () => databases.getService(project);
  return {
    async getContainerTrace(containerId: string, query: KernelTraceReadQuery) {
      return (await queryService()?.getContainerTrace(containerId, query)) ?? null;
    },
    async listSessionContainers(query: KernelTraceReadQuery) {
      return (
        (await queryService()?.listSessionContainers?.(query)) ?? {
          trace_sessions: [],
        }
      );
    },
    async getBlob(hash: string) {
      return (await queryService()?.getBlob?.(hash)) ?? null;
    },
    async getRunTurnContext(runId: string, turnNumber: number) {
      return (
        (await queryService()?.getRunTurnContext?.(runId, turnNumber)) ?? null
      );
    },
  };
}

export function createObservatoryApp(
  registry: LoadedRegistry,
  options: CreateObservatoryAppOptions = {},
): ObservatoryApp {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const databases = new ProjectDatabaseManager();
  const liveness = new LivenessMonitor(registry.projects, {
    ...options.liveness,
    fetch: fetchImpl,
  });
  const launcher = new ProjectLauncher(registry, liveness, options.launcher);
  const projectById = new Map(
    registry.projects.map((project) => [project.id, project]),
  );

  let app = new Elysia().get("/health", () => ({
    status: "ok",
    projects: registry.projects.length,
  }));

  for (const project of registry.projects) {
    const traceApi = createKernelTraceReadApi(
      missingDatabaseService(databases, project),
      { prefix: `/registry/kernels/${project.id}/kernel` },
    );
    app = app.use(traceApi as unknown as Elysia);
  }

  app
    .get("/registry/projects", async () => {
      const states = await liveness.probeAll();
      return {
        projects: registry.projects.map((project) => {
          const state = states.get(project.id) ?? liveness.state(project.id);
          return {
            id: project.id,
            name: project.name,
            kernelId: project.kernelId,
            live: state.live,
            checkedAt: state.checkedAt,
            writable: project.writable,
            tracesAvailable: databases.hasDatabase(project),
            readApiBaseUrl: project.readApiBaseUrl,
            viewerBaseUrl: project.viewerBaseUrl,
            extensionPackage: project.extensionPackage,
            launchable: project.launchCommand !== null,
            managed: launcher.status(project.id),
          };
        }),
      };
    })
    .post("/registry/projects/:id/launch", async ({ params, set }) => {
      try {
        const managed = await launcher.start(params.id);
        set.status = 202;
        return { managed };
      } catch (error) {
        return launcherErrorResponse(error, set);
      }
    })
    .post("/registry/projects/:id/stop", async ({ params, set }) => {
      try {
        const managed = await launcher.stop(params.id);
        return { managed };
      } catch (error) {
        return launcherErrorResponse(error, set);
      }
    })
    .get("/registry/projects/:id/logs", ({ params, set }) => {
      try {
        return launcher.logs(params.id);
      } catch (error) {
        return launcherErrorResponse(error, set);
      }
    })
    .all(
      "/registry/kernels/:id/kernel/*",
      async ({ params, request, set }) => {
        const project = projectById.get(params.id);
        if (!project) {
          set.status = 404;
          return { error: `Registry project ${params.id} not found` };
        }
        const method = request.method.toUpperCase();
        if (
          isWriteGatedKernelPath(params["*"]) &&
          method !== "GET" &&
          method !== "HEAD" &&
          !project.writable
        ) {
          set.status = 403;
          return { error: "Project catalog is read-only" };
        }
        const { live } = await liveness.probe(project);
        if (!live) {
          set.status = 503;
          return { live: false };
        }
        try {
          return await proxyKernelRequest(
            request,
            project,
            params["*"],
            fetchImpl,
          );
        } catch {
          liveness.markOffline(project.id);
          set.status = 503;
          return { live: false };
        }
      },
    );

  if (options.startLiveness ?? true) liveness.start();
  if (options.autoLaunch ?? true) launcher.autoLaunch();

  return {
    app,
    liveness,
    launcher,
    databases,
    async close() {
      liveness.stop();
      await launcher.stopAll();
      databases.close();
    },
  };
}

function launcherErrorResponse(
  error: unknown,
  set: { status?: number | string },
): { error: string } {
  if (!(error instanceof LauncherError)) throw error;
  set.status =
    error.code === "unknown_project"
      ? 404
      : error.code === "no_launch_command"
        ? 400
        : 409;
  return { error: error.message };
}
