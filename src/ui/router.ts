/**
 * Minimal history router for the Observatory's page structure:
 *
 *   /                                  → redirects to the first project
 *   /:projectId                        → project page (trace list at rest)
 *   /:projectId/agent/:agentName/:view? → agent page and document view
 *   /:projectId/trace/:traceId         → trace page (list + opened trace)
 *
 * Deliberately no dependency: three route shapes over pushState/popstate.
 */
import { useCallback, useEffect, useState } from "react";
import type { LabView } from "@codecaine-ai/prompt-kit/ui/lab";

const AGENT_VIEWS = new Set<string>(["system", "context", "state", "tools"]);

export type Route =
  | { kind: "home" }
  | { kind: "project"; projectId: string }
  | { kind: "agent"; projectId: string; agentName: string; view: LabView }
  | { kind: "trace"; projectId: string; traceId: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodeURIComponent);
  const [projectId, section, id, view] = parts;
  if (!projectId) return { kind: "home" };
  if (section === "agent" && id) return { kind: "agent", projectId, agentName: id, view: view && AGENT_VIEWS.has(view) ? view as LabView : "system" };
  if (section === "trace" && id) return { kind: "trace", projectId, traceId: id };
  return { kind: "project", projectId };
}

export function projectPath(projectId: string): string {
  return `/${encodeURIComponent(projectId)}`;
}

export function agentPath(projectId: string, agentName: string, view: LabView = "system"): string {
  return `${projectPath(projectId)}/agent/${encodeURIComponent(agentName)}/${view}`;
}

export function tracePath(projectId: string, traceId: string): string {
  return `${projectPath(projectId)}/trace/${encodeURIComponent(traceId)}`;
}

export function useRoute(): {
  route: Route;
  navigate: (path: string, options?: { replace?: boolean }) => void;
} {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback(
    (path: string, options?: { replace?: boolean }) => {
      if (path === window.location.pathname) return;
      if (options?.replace) {
        window.history.replaceState(null, "", path);
      } else {
        window.history.pushState(null, "", path);
      }
      setPathname(path);
    },
    [],
  );

  return { route: parseRoute(pathname), navigate };
}
