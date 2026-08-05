import type { FetchLike } from "./liveness";
import type { ResolvedRegistryProject } from "./registry";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filteredHeaders(input: Headers): Headers {
  const output = new Headers();
  for (const [name, value] of input) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      output.set(name, value);
    }
  }
  return output;
}

export async function proxyKernelRequest(
  request: Request,
  project: ResolvedRegistryProject,
  wildcardPath: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<Response> {
  if (!project.readApiBaseUrl) {
    return Response.json({ live: false }, { status: 503 });
  }

  const incomingUrl = new URL(request.url);
  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  const makeTarget = (prefix: string): URL => {
    const target = new URL(project.readApiBaseUrl!);
    const configuredPrefix = target.pathname.replace(/\/+$/, "");
    target.pathname = `${configuredPrefix}${prefix}/${wildcardPath}`;
    target.search = incomingUrl.search;
    return target;
  };
  const requestUpstream = (target: URL) =>
    fetchImpl(target, {
      method,
      headers: filteredHeaders(request.headers),
      body,
      redirect: "manual",
    });

  let response = await requestUpstream(makeTarget("/kernel"));
  // Canvas's current Elysia harness mounts its standard and app-specific
  // kernel APIs at /api/agent/kernel. Retry that legacy host prefix only for
  // an unmatched route, never for a real JSON 404 from a mounted handler.
  if (
    response.status === 404
    && (await response.clone().text()) === "NOT_FOUND"
  ) {
    response = await requestUpstream(makeTarget("/api/agent/kernel"));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filteredHeaders(response.headers),
  });
}
