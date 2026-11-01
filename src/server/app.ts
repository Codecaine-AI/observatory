import { Elysia } from "elysia";

import { readActions } from "./actions";
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
import type { LoadedRegistry } from "./registry";

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

export function createObservatoryApp(
  registry: LoadedRegistry,
  options: CreateObservatoryAppOptions = {},
): ObservatoryApp {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const liveness = new LivenessMonitor(registry.projects, {
    ...options.liveness,
    fetch: fetchImpl,
  });
  const launcher = new ProjectLauncher(registry, liveness, options.launcher);
  const projectById = new Map(
    registry.projects.map((project) => [project.id, project]),
  );

  const app = new Elysia()
    .get("/health", () => ({
      status: "ok",
      projects: registry.projects.length,
    }))
    .get("/api/actions", ({ request, set }) => {
      try {
        return readActions(new URL(request.url).searchParams);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        set.status = 400;
        return { error: error.message };
      }
    })
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
    async close() {
      liveness.stop();
      await launcher.stopAll();
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
