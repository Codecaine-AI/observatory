import type { ResolvedRegistryProject } from "./registry";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProjectLiveness {
  live: boolean;
  checkedAt: string | null;
}

export interface LivenessMonitorOptions {
  fetch?: FetchLike;
  intervalMs?: number;
  timeoutMs?: number;
}

export class LivenessMonitor {
  readonly #states = new Map<string, ProjectLiveness>();
  readonly #fetch: FetchLike;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly projects: ResolvedRegistryProject[],
    options: LivenessMonitorOptions = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#intervalMs = options.intervalMs ?? 5_000;
    this.#timeoutMs = options.timeoutMs ?? 800;
    for (const project of projects) {
      this.#states.set(project.id, { live: false, checkedAt: null });
    }
  }

  state(projectId: string): ProjectLiveness {
    return this.#states.get(projectId) ?? { live: false, checkedAt: null };
  }

  markOffline(projectId: string): void {
    this.#states.set(projectId, {
      live: false,
      checkedAt: new Date().toISOString(),
    });
  }

  async probe(project: ResolvedRegistryProject): Promise<ProjectLiveness> {
    if (!project.readApiBaseUrl) {
      const state = {
        live: false,
        checkedAt: new Date().toISOString(),
      };
      this.#states.set(project.id, state);
      return state;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const healthUrl = new URL("/health", project.readApiBaseUrl);
      const response = await this.#fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const state = {
        live: response.ok,
        checkedAt: new Date().toISOString(),
      };
      this.#states.set(project.id, state);
      return state;
    } catch {
      const state = {
        live: false,
        checkedAt: new Date().toISOString(),
      };
      this.#states.set(project.id, state);
      return state;
    } finally {
      clearTimeout(timeout);
    }
  }

  async probeAll(): Promise<Map<string, ProjectLiveness>> {
    await Promise.all(this.projects.map((project) => this.probe(project)));
    return new Map(this.#states);
  }

  start(): void {
    if (this.#timer) return;
    void this.probeAll();
    this.#timer = setInterval(() => {
      void this.probeAll();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
