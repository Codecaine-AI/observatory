import { useCallback, useEffect, useState } from "react";
import { parseSessionQuery, parseTokensQuery, parseWorkQuery, sessionQuery, tokensQuery, workQuery, type SidebarRoute } from "@codecaine-ai/agent-kernel-viewer-shell";

/**
 * The Observatory pages.
 *
 *   /                       the Action log (local mode), the Work tab (server mode)
 *   /traces/:projectId      the kernel Traces page (local mode)
 *   /runs/:engine/:runId    the engine Runs page (both modes)
 *   /work                   the Work tab: the Sessions; ?search=<text>&phase=<phase>&machine=<machine>
 *                           holds the search and the filters
 *   /sessions/:sessionId    one Session as a tree; ?node=<kind>:<id>&call=<callId>
 *                           holds the selected node and call
 *   /orphans                the nodes with no parent edge whose subtree has calls
 *   /unlinked-calls         the calls that join no node, grouped by cause
 *   /workflows              the Workflows tab: the workflow runs by workflow
 *   /tokens                 the Tokens tab: the token use by model; ?range=1d|30d|all holds the range (7d is the default)
 */
export type Route =
  | { page: "actions" }
  | { page: "traces"; projectId: string | null }
  | { page: "runs"; run: { engine: string; runId: string } | null }
  | SidebarRoute;

/** The route of a URL. `search` is the query, such as `?node=thread:t1`; only the Work and Session routes read it. */
export function parseRoute(pathname: string, search = ""): Route {
  if (/^\/work\/?$/.test(pathname)) {
    const filter = parseWorkQuery(search);
    return Object.keys(filter).length > 0 ? { page: "work", filter } : { page: "work" };
  }
  if (/^\/workflows\/?$/.test(pathname)) return { page: "workflows" };
  if (/^\/tokens\/?$/.test(pathname)) {
    const range = parseTokensQuery(search);
    return range ? { page: "tokens", range } : { page: "tokens" };
  }
  if (/^\/orphans\/?$/.test(pathname)) return { page: "orphans" };
  if (/^\/unlinked-calls\/?$/.test(pathname)) return { page: "unlinked-calls" };
  const session = /^\/sessions\/([^/]+)\/?$/.exec(pathname);
  if (session?.[1]) {
    const { node, call } = parseSessionQuery(search);
    return { page: "session", sessionId: decodeSegment(session[1]), ...(node ? { node } : {}), ...(call ? { call } : {}) };
  }
  const runs = /^\/runs(?:\/([^/]+)\/([^/]+))?\/?$/.exec(pathname);
  if (runs) {
    return {
      page: "runs",
      run:
        runs[1] && runs[2]
          ? { engine: decodeSegment(runs[1]), runId: decodeSegment(runs[2]) }
          : null,
    };
  }
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
 * so the page shows "not found" (or the run's read error) instead of throwing.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The page that server mode shows for a route. Server mode has no Action log
 * and no Traces page, so `/`, `/traces` and an unknown path show the Work tab.
 */
export function serverRoute(route: Route): SidebarRoute | Extract<Route, { page: "runs" }> {
  if (route.page === "actions" || route.page === "traces") return { page: "work" };
  return route;
}

/** The page that local mode shows for a route. Local mode has no Session routes, so their pages show the Action log. */
export function localRoute(route: Route): Exclude<Route, SidebarRoute> {
  if (route.page === "runs" || route.page === "actions" || route.page === "traces") return route;
  return { page: "actions" };
}

/**
 * The tab title of a local page, before the app name: the Action log, or the
 * Traces page of a project. Null for the Runs page, which names itself.
 */
export function localPageTitle(route: Exclude<Route, SidebarRoute>, projectName: string | null): string | null {
  if (route.page === "runs") return null;
  if (route.page === "traces") return projectName ? `${projectName} · Traces` : "Traces";
  return "Action log";
}

export function routePath(route: Route): string {
  if (route.page === "actions") return "/";
  if (route.page === "work") return `/work${workQuery(route.filter)}`;
  if (route.page === "workflows") return "/workflows";
  if (route.page === "tokens") return `/tokens${tokensQuery(route.range)}`;
  if (route.page === "orphans") return "/orphans";
  if (route.page === "unlinked-calls") return "/unlinked-calls";
  if (route.page === "session") return `/sessions/${encodeURIComponent(route.sessionId)}${sessionQuery(route)}`;
  if (route.page === "runs") {
    return route.run
      ? `/runs/${encodeURIComponent(route.run.engine)}/${encodeURIComponent(route.run.runId)}`
      : "/runs";
  }
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

/**
 * The address to write in place of a Work address whose query holds a value
 * the page drops (such as `?phase=bogus`), so the address shows the filter
 * that applies. Null when the address is already clean, and for every other
 * page.
 */
export function cleanAddress(route: Route, pathname: string, search: string): string | null {
  if (route.page !== "work") return null;
  const path = routePath(route);
  return path === `${pathname}${search}` ? null : path;
}

/** The route of the address bar. A Work address with dropped values is replaced in place, with no new history entry. */
function readAddress(): Route {
  const { pathname, search, hash } = window.location;
  const route = parseRoute(pathname, search);
  const clean = cleanAddress(route, pathname, search);
  if (clean !== null) window.history.replaceState(window.history.state, "", `${clean}${hash}`);
  return route;
}

/**
 * Reads the route from the URL and keeps it in step with pushState and
 * back/forward. Each new address is a history entry, so on a Session page
 * the back button walks the selection history.
 */
export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(readAddress);

  useEffect(() => {
    const onPopState = () => setRoute(readAddress());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = routePath(next);
    if (path !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState(null, "", path);
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
