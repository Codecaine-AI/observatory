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
      projectId: match[1] ? decodeSegment(match[1]) : null,
    };
  }
  return { page: "actions" };
}

/**
 * Decodes one path segment. A malformed escape such as `%` stays as written,
 * so the page shows "not found" for it instead of throwing.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function routePath(route: Route): string {
  if (route.page === "actions") return "/";
  return route.projectId
    ? `/traces/${encodeURIComponent(route.projectId)}`
    : "/traces";
}

type ClickLike = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};

/**
 * True for an ordinary same-tab click. A link lets the browser handle every
 * other click (cmd, ctrl, shift, alt, middle), so those open a new tab or window.
 */
export function isPlainLeftClick(event: ClickLike): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
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
