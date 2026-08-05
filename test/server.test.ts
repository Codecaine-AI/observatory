import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  containers,
  ensureKernelObservabilitySchema,
  openKernelDatabase,
  piAgentSessions,
  traceBlobs,
  traceEvents,
} from "@agent-kernel/db";
import { createKernelCatalogService } from "@agent-kernel/kernel";
import { buildRegistry } from "@agent-kernel/kernel/agent-registry";
import { createKernelCatalogApi } from "@agent-kernel/kernel/catalog-api";

import { createObservatoryApp, type ObservatoryApp } from "../src/server/app";
import type { FetchLike } from "../src/server/liveness";
import type {
  LoadedRegistry,
  ResolvedRegistryProject,
} from "../src/server/registry";

const temporaryDirectories: string[] = [];
const openApps: ObservatoryApp[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "observatory-server-"));
  temporaryDirectories.push(directory);
  return directory;
}

function project(
  overrides: Partial<ResolvedRegistryProject> = {},
): ResolvedRegistryProject {
  const directory = overrides.kernelRoot ?? makeTemporaryDirectory();
  return {
    id: "fixture",
    name: "Fixture",
    kernelId: "fixture-kernel",
    kernelRoot: directory,
    dbPath: join(directory, "trace.db"),
    catalogRoots: [],
    readApiBaseUrl: "http://127.0.0.1:9876",
    viewerBaseUrl: null,
    extensionPackage: null,
    launchCommand: null,
    autoLaunch: false,
    writable: true,
    manifest: null,
    ...overrides,
  };
}

function registry(entry: ResolvedRegistryProject): LoadedRegistry {
  return {
    path: join(entry.kernelRoot, "registry.json"),
    directory: entry.kernelRoot,
    registryVersion: 1,
    projects: [entry],
  };
}

function buildApp(
  entry: ResolvedRegistryProject,
  fetchImpl: FetchLike,
): ObservatoryApp {
  const observatory = createObservatoryApp(registry(entry), {
    fetch: fetchImpl,
    startLiveness: false,
    liveness: { timeoutMs: 100 },
  });
  openApps.push(observatory);
  return observatory;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("liveness and kernel passthrough", () => {
  test("reports live projects after an on-demand health probe", async () => {
    const calls: string[] = [];
    const fetchMock = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ status: "ok" });
    });
    const entry = project();
    const { app } = buildApp(entry, fetchMock);

    const response = await app.handle(
      new Request("http://observatory/registry/projects"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projects: [{ id: "fixture", live: true, writable: true }],
    });
    expect(calls).toEqual(["http://127.0.0.1:9876/health"]);
  });

  test("returns exact offline response without attempting a kernel request", async () => {
    const calls: string[] = [];
    const fetchMock = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("connection refused");
    });
    const { app } = buildApp(project(), fetchMock);

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/sessions/session-1/transcript",
      ),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ live: false });
    expect(calls).toEqual(["http://127.0.0.1:9876/health"]);
  });

  test("proxies catalog method, query, body, status, and response headers", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const fetchMock = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? await new Response(init.body).text() : "",
      });
      return Response.json(
        { hash: "pk1-new" },
        { status: 202, headers: { "x-harness": "fixture" } },
      );
    });
    const { app } = buildApp(project(), fetchMock);

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/catalog/agents/writer/prompt?mode=save",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: 1 }),
        },
      ),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("x-harness")).toBe("fixture");
    expect(await response.json()).toEqual({ hash: "pk1-new" });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:9876/kernel/catalog/agents/writer/prompt?mode=save",
        method: "PUT",
        body: '{"version":1}',
      },
    ]);
  });

  test("proxies app-specific kernel routes through the standard upstream prefix", async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      return Response.json({
        sessions: [{ id: "pi-session-1", messages: [] }],
      });
    };
    const { app } = buildApp(project(), fetchMock);

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/sessions/session-1/transcript?images=metadata",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [{ id: "pi-session-1", messages: [] }],
    });
    expect(calls).toEqual([
      "http://127.0.0.1:9876/health",
      "http://127.0.0.1:9876/kernel/sessions/session-1/transcript?images=metadata",
    ]);
  });

  test("blocks catalog mutations before probing when the registry marks a project read-only", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return Response.json({});
    });
    const { app } = buildApp(project({ writable: false }), fetchMock);

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/catalog/agents/a/prompt",
        { method: "PUT", body: "{}" },
      ),
    );

    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("falls back to Canvas's legacy API prefix for app-specific routes", async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      if (url.includes("/api/agent/kernel/")) {
        return Response.json({
          sessions: [{ id: "pi-session-1", messages: [] }],
        });
      }
      return new Response("NOT_FOUND", { status: 404 });
    };
    const { app } = buildApp(project(), fetchMock);

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/sessions/session-1/transcript",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [{ id: "pi-session-1", messages: [] }],
    });
    expect(calls).toEqual([
      "http://127.0.0.1:9876/health",
      "http://127.0.0.1:9876/kernel/sessions/session-1/transcript",
      "http://127.0.0.1:9876/api/agent/kernel/sessions/session-1/transcript",
    ]);
  });
});

describe("prompt-edit session passthrough", () => {
  test("proxies session creation and driving routes for a writable project", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const fetchMock: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? await new Response(init.body as BodyInit).text() : "",
      });
      return Response.json({ ok: true });
    };
    const { app } = buildApp(project(), fetchMock);
    const base = "http://observatory/registry/kernels/fixture/kernel";

    for (const [path, body] of [
      ["/catalog/agents/prompt-editor/edit-sessions", '{"requests":[]}'],
      ["/prompt-edit-sessions/session-1/requests", '{"text":"tighten it"}'],
      ["/prompt-edit-sessions/session-1/requests/R1/accept", "{}"],
    ] as const) {
      const response = await app.handle(
        new Request(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(200);
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:9876/kernel/catalog/agents/prompt-editor/edit-sessions",
        method: "POST",
        body: '{"requests":[]}',
      },
      {
        url: "http://127.0.0.1:9876/kernel/prompt-edit-sessions/session-1/requests",
        method: "POST",
        body: '{"text":"tighten it"}',
      },
      {
        url: "http://127.0.0.1:9876/kernel/prompt-edit-sessions/session-1/requests/R1/accept",
        method: "POST",
        body: "{}",
      },
    ]);
  });

  test("streams session SSE events through the proxy", async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('event: status\ndata: {"state":"running"}\n\n'),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const { app } = buildApp(project(), fetchMock);

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/prompt-edit-sessions/session-1/events",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(
      'event: status\ndata: {"state":"running"}\n\n',
    );
  });

  test("blocks session mutations for read-only projects without probing", async () => {
    let calls = 0;
    const fetchMock: FetchLike = async () => {
      calls += 1;
      return Response.json({});
    };
    const { app } = buildApp(project({ writable: false }), fetchMock);
    const base = "http://observatory/registry/kernels/fixture/kernel";

    for (const path of [
      "/catalog/agents/prompt-editor/edit-sessions",
      "/prompt-edit-sessions/session-1/requests",
      "/prompt-edit-sessions/session-1/requests/R1/accept",
      "/prompt-edit-sessions/session-1/requests/R1/undo",
    ]) {
      const response = await app.handle(
        new Request(`${base}${path}`, { method: "POST", body: "{}" }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Project catalog is read-only",
      });
    }
    expect(calls).toBe(0);
  });

  test("keeps session reads available for read-only projects", async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      return Response.json({ session: { id: "session-1" } });
    };
    const { app } = buildApp(project({ writable: false }), fetchMock);

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/prompt-edit-sessions/session-1",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { id: "session-1" } });
    expect(calls).toEqual([
      "http://127.0.0.1:9876/health",
      "http://127.0.0.1:9876/kernel/prompt-edit-sessions/session-1",
    ]);
  });

  test("discovers the prompt-editor bundle through the catalog passthrough", async () => {
    // Real upstream: the kernel catalog api over the first-party
    // prompt-kit-agent catalog root, which ships the prompt-editor bundle every
    // writable harness registers (canvas kernel.ts pattern).
    const catalogRoot = join(
      import.meta.dir,
      "..",
      "..",
      "prompt-kit",
      "packages",
      "prompt-kit-agent",
      "catalog",
    );
    const registry = await buildRegistry({ roots: [catalogRoot] });
    const service = createKernelCatalogService({
      registry: async () => registry,
      db: () => {
        throw new Error("no trace db in this fixture");
      },
    });
    const upstream = createKernelCatalogApi(service, { prefix: "/kernel" });
    const fetchMock: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      return upstream.handle(new Request(url, init));
    };
    const { app } = buildApp(project(), fetchMock);

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/catalog/agents",
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agents: Array<{ name: string; valid: boolean }>;
    };
    const promptEditor = body.agents.find(
      (agent) => agent.name === "prompt-editor",
    );
    expect(promptEditor).toMatchObject({ name: "prompt-editor", valid: true });
  });
});

describe("local read-only trace routes", () => {
  test("serves session list, detail, container trace, and blobs from SQLite", async () => {
    const directory = makeTemporaryDirectory();
    const dbPath = join(directory, "trace.db");
    const writer = openKernelDatabase({ path: dbPath });
    await ensureKernelObservabilitySchema(writer.db);
    const timestamp = "2026-07-30T12:00:00.000Z";
    const hash = `b1-${"a".repeat(64)}`;

    await writer.db.insert(containers).values({
      id: "session-1",
      kernelId: "fixture-kernel",
      kind: "layout-session",
      appKey: ["session-1"],
      label: "Fixture trace",
      status: "done",
      metadata: { instruction: "Testing Observatory" },
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: timestamp,
    });
    await writer.db.insert(piAgentSessions).values({
      id: "pi-1",
      containerId: "session-1",
      agentName: "writer",
      status: "ended",
      createdAt: timestamp,
      endedAt: timestamp,
    });
    await writer.db.insert(traceEvents).values({
      eventId: "event-1",
      containerId: "session-1",
      piSessionId: "pi-1",
      type: "app:test",
      source: "fixture",
      traceLevel: 0,
      eventData: { message: "visible" },
      timestamp,
    });
    await writer.db.insert(traceBlobs).values({
      hash,
      kind: "text",
      mimeType: "text/plain",
      byteLength: 7,
      data: Buffer.from("fixture"),
      createdAt: timestamp,
    });
    writer.close();

    const entry = project({ kernelRoot: directory, dbPath });
    const { app } = buildApp(
      entry,
      async () => Response.json({ status: "ok" }),
    );
    const base =
      "http://observatory/registry/kernels/fixture/kernel";

    const listResponse = await app.handle(
      new Request(`${base}/trace-sessions`),
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      trace_sessions: [
        {
          id: "session-1",
          topic: "Testing Observatory",
          piSessionCount: 1,
          eventCount: 1,
        },
      ],
    });

    for (const path of [
      "/trace-sessions/session-1",
      "/containers/session-1/trace",
    ]) {
      const detailResponse = await app.handle(new Request(`${base}${path}`));
      expect(detailResponse.status).toBe(200);
      expect(await detailResponse.json()).toMatchObject({
        session: { id: "session-1" },
        events: [{ eventId: "event-1", eventData: { message: "visible" } }],
      });
    }

    const blobResponse = await app.handle(
      new Request(`${base}/blobs/${hash}`),
    );
    expect(blobResponse.status).toBe(200);
    expect(blobResponse.headers.get("content-type")).toBe("text/plain");
    expect(await blobResponse.text()).toBe("fixture");
  });

  test("treats a missing database as no traces yet", async () => {
    const entry = project();
    const calls: string[] = [];
    const { app } = buildApp(
      entry,
      async (input) => {
        calls.push(String(input));
        return Response.json({ status: "ok" });
      },
    );

    const response = await app.handle(
      new Request(
        "http://observatory/registry/kernels/fixture/kernel/trace-sessions",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ trace_sessions: [] });
    expect(calls).toEqual([]);
  });
});
