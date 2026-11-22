/**
 * The API that the UI reads, for the local sidebar. The dev server proxies
 * /api to its API_TARGET, which vite writes in as `__OBSERVATORY_API_TARGET__`.
 * A build has none: it is served beside the API at the same origin.
 */
declare const __OBSERVATORY_API_TARGET__: string | undefined;

const definedTarget = (): string => (typeof __OBSERVATORY_API_TARGET__ === "string" ? __OBSERVATORY_API_TARGET__ : "");

/** `API 127.0.0.1:4160`: the host and port of the API target, else of the page's own origin. */
export function apiLabel(target: string = definedTarget(), pageHost: string = typeof window === "undefined" ? "" : window.location.host): string {
  let host = pageHost;
  if (target !== "") {
    try {
      host = new URL(target).host;
    } catch {
      host = target;
    }
  }
  return host === "" ? "API" : `API ${host}`;
}
