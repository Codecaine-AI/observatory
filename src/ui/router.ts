import { useCallback, useEffect, useState } from "react";

/**
 * The 3 Observatory pages. `/` is the Action log, `/traces/:projectId` the
 * kernel Traces page, `/runs/:engine/:runId` the engine Runs page.
 */
export type Route =
  | { page: "actions" }
  | { page: "traces"; projectId: string | null }
  | { page: "runs"; run: { engine: string; runId: string } | null };

export function parseRoute(pathname: string): Route {
  const runs = /^\/runs(?:\/([^/]+)\/([^/]+))?\/?$/.exec(pathname);
  if (runs) {
    return {
      page: "runs",
      run:
        runs[1] && runs[2]
          ? { engine: decodeURIComponent(runs[1]), runId: decodeURIComponent(runs[2]) }
          : null,
    };
  }
  const match = /^\/traces(?:\/([^/]+))?\/?$/.exec(pathname);
  if (match) {
    return {
      page: "traces",
      projectId: match[1] ? decodeURIComponent(match[1]) : null,
    };
  }
  return { page: "actions" };
}

export function routePath(route: Route): string {
  if (route.page === "actions") return "/";
  if (route.page === "runs") {
    return route.run
      ? `/runs/${encodeURIComponent(route.run.engine)}/${encodeURIComponent(route.run.runId)}`
      : "/runs";
  }
  return route.projectId
    ? `/traces/${encodeURIComponent(route.projectId)}`
    : "/traces";
}

/** Reads the route from the URL and keeps it in step with pushState and back/forward. */
export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname),
  );

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = routePath(next);
    if (path !== window.location.pathname) {
      window.history.pushState(null, "", path);
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
