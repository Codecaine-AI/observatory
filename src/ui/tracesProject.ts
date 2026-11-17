import type { RegistryProject } from "./api";

/** What the Traces page shows for a route's project id. */
export type TracesProject =
  | { kind: "project"; project: RegistryProject }
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "not-found"; projectId: string };

/**
 * `/traces` (no id) falls back to the first project. An explicit id never
 * falls back to another project: an unknown id is "not found".
 */
export function resolveTracesProject(
  projects: RegistryProject[],
  projectId: string | null,
  loading: boolean,
): TracesProject {
  if (projects.length === 0 && loading) return { kind: "loading" };
  if (projectId === null) {
    const first = projects[0];
    return first ? { kind: "project", project: first } : { kind: "none" };
  }
  const project = projects.find((candidate) => candidate.id === projectId);
  return project ? { kind: "project", project } : { kind: "not-found", projectId };
}
