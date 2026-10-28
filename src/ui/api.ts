import {
  KERNEL_CATALOG_PATHS,
  KERNEL_TRACE_READ_PATHS,
  type CatalogAgentDetail,
  type CatalogAgentListResponse,
  type KernelTraceSessionDetail,
  type KernelTraceSessionListResponse,
} from "@codecaine-ai/agent-kernel-viewer-core";

export interface RegistryProject {
  id: string;
  name: string;
  live: boolean;
  writable: boolean;
  tracesAvailable?: boolean;
  extensionPackage: string | null;
  launchable: boolean;
  managed: ManagedProjectStatus;
  kernelRoot?: string;
  dbPath?: string;
  readApiBaseUrl?: string;
  viewerBaseUrl?: string | null;
}

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

interface RegistryProjectsResponse {
  projects: RegistryProject[];
}

/**
 * The shared viewer packages append viewer-core paths such as
 * `/kernel/blobs/:hash` and `/kernel/catalog/agents` themselves. This prefix
 * therefore stops before `/kernel`.
 */
export function viewerApiPrefix(projectId: string): string {
  return `/registry/kernels/${encodeURIComponent(projectId)}`;
}

/** Full kernel route base for direct Observatory fetches and extensions. */
export function kernelApiBase(projectId: string): string {
  return `${viewerApiPrefix(projectId)}/kernel`;
}

export async function fetchRegistryProjects(signal?: AbortSignal): Promise<RegistryProject[]> {
  const body = await requestJson<RegistryProjectsResponse | RegistryProject[]>(
    "/registry/projects",
    signal,
  );
  const projects = Array.isArray(body) ? body : body.projects;
  if (!Array.isArray(projects)) {
    throw new Error("Project registry returned an invalid project list.");
  }
  return projects.map(normalizeProject);
}

export async function launchRegistryProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<ManagedProjectStatus> {
  const body = await requestJson<{ managed: ManagedProjectStatus }>(
    `/registry/projects/${encodeURIComponent(projectId)}/launch`,
    signal,
    { method: "POST" },
  );
  return normalizeManagedStatus(body.managed);
}

export async function stopRegistryProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<ManagedProjectStatus> {
  const body = await requestJson<{ managed: ManagedProjectStatus }>(
    `/registry/projects/${encodeURIComponent(projectId)}/stop`,
    signal,
    { method: "POST" },
  );
  return normalizeManagedStatus(body.managed);
}

export async function fetchProjectLogs(
  projectId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const body = await requestJson<{ lines?: unknown }>(
    `/registry/projects/${encodeURIComponent(projectId)}/logs`,
    signal,
  );
  if (!Array.isArray(body.lines) || !body.lines.every((line) => typeof line === "string")) {
    throw new Error("Project logs returned an invalid response.");
  }
  return body.lines;
}

export async function fetchCatalogAgents(
  projectId: string,
  signal?: AbortSignal,
): Promise<CatalogAgentListResponse> {
  return requestJson<CatalogAgentListResponse>(
    `${viewerApiPrefix(projectId)}${KERNEL_CATALOG_PATHS.listAgents}`,
    signal,
  );
}

export async function fetchCatalogAgentDetail(
  projectId: string,
  agentName: string,
  signal?: AbortSignal,
): Promise<CatalogAgentDetail> {
  return requestJson<CatalogAgentDetail>(
    `${viewerApiPrefix(projectId)}${KERNEL_CATALOG_PATHS.agentDetail(agentName)}`,
    signal,
  );
}

export async function fetchTraceSessions(
  projectId: string,
  signal?: AbortSignal,
): Promise<KernelTraceSessionListResponse> {
  return requestJson<KernelTraceSessionListResponse>(
    `${viewerApiPrefix(projectId)}${KERNEL_TRACE_READ_PATHS.listTraceSessions}`,
    signal,
  );
}

export async function fetchTraceSessionDetail(
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<KernelTraceSessionDetail> {
  return requestJson<KernelTraceSessionDetail>(
    `${viewerApiPrefix(projectId)}${KERNEL_TRACE_READ_PATHS.traceSessionDetail(sessionId)}`,
    signal,
  );
}

async function requestJson<T>(
  url: string,
  signal?: AbortSignal,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    signal,
  });
  if (!response.ok) {
    const message = await responseMessage(response);
    throw new Error(message ?? `Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

async function responseMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      message?: unknown;
      live?: unknown;
    };
    if (typeof body.error === "string") return body.error;
    if (typeof body.message === "string") return body.message;
    if (body.live === false) return "Harness not running.";
  } catch {
    // A status-only error is sufficient for non-JSON responses.
  }
  return null;
}

function normalizeProject(value: RegistryProject): RegistryProject {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string"
  ) {
    throw new Error("Project registry contains an invalid project.");
  }
  return {
    ...value,
    live: value.live === true,
    writable: value.writable === true,
    tracesAvailable: value.tracesAvailable !== false,
    launchable: value.launchable === true,
    managed: normalizeManagedStatus(value.managed),
    extensionPackage:
      typeof value.extensionPackage === "string" ? value.extensionPackage : null,
  };
}

const MANAGED_STATES = new Set<ManagedProjectState>([
  "idle",
  "starting",
  "running",
  "stopped",
  "exited",
  "failed",
]);

function normalizeManagedStatus(value: unknown): ManagedProjectStatus {
  if (!value || typeof value !== "object") return { state: "idle" };
  const candidate = value as Partial<ManagedProjectStatus>;
  const state =
    typeof candidate.state === "string"
    && MANAGED_STATES.has(candidate.state as ManagedProjectState)
      ? (candidate.state as ManagedProjectState)
      : "idle";
  return {
    state,
    ...(typeof candidate.pid === "number" ? { pid: candidate.pid } : {}),
    ...(typeof candidate.exitCode === "number"
      ? { exitCode: candidate.exitCode }
      : {}),
    ...(typeof candidate.startedAt === "string"
      ? { startedAt: candidate.startedAt }
      : {}),
  };
}
