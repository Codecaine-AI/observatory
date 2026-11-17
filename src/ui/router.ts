import { useCallback, useEffect, useState } from "react";

/** The 2 Observatory pages. `/` is the Action log, `/traces/:projectId` the Traces page. */
export type Route =
  | { page: "actions" }
  | { page: "traces"; projectId: string | null };

export function parseRoute(pathname: string): Route {
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
