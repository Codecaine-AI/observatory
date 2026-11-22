import { describe, expect, test } from "bun:test";

import { isPlainLeftClick, localRoute, parseRoute, routePath, serverRoute, type Route } from "../src/ui/router";

describe("the page routes", () => {
  test("read and write the Action log and Traces pages", () => {
    const routes: [string, Route][] = [
      ["/", { page: "actions" }],
      ["/traces", { page: "traces", projectId: null }],
      ["/traces/simple-research", { page: "traces", projectId: "simple-research" }],
      ["/traces/team%2Fkernel%20one", { page: "traces", projectId: "team/kernel one" }],
    ];
    for (const [path, route] of routes) {
      expect(parseRoute(path)).toEqual(route);
      expect(routePath(route)).toBe(path);
    }
  });

  test("read and write the Runs page with and without an open run", () => {
    const routes: [string, Route][] = [
      ["/runs", { page: "runs", run: null }],
      ["/runs/archon/c5993f42-7c8b", { page: "runs", run: { engine: "archon", runId: "c5993f42-7c8b" } }],
      ["/runs/archon/run%2F1", { page: "runs", run: { engine: "archon", runId: "run/1" } }],
    ];
    for (const [path, route] of routes) {
      expect(parseRoute(path)).toEqual(route);
      expect(routePath(route)).toBe(path);
    }
  });

  test("read and write the Work, Session and Workflows pages", () => {
    const routes: [string, Route][] = [
      ["/work", { page: "work" }],
      ["/sessions/ses_01JZ8Q4V6X2M9R3T5W7Y1A3C5E", { page: "session", sessionId: "ses_01JZ8Q4V6X2M9R3T5W7Y1A3C5E" }],
      ["/sessions/a%2Fb", { page: "session", sessionId: "a/b" }],
      ["/workflows", { page: "workflows" }],
    ];
    for (const [path, route] of routes) {
      expect(parseRoute(path)).toEqual(route);
      expect(routePath(route)).toBe(path);
    }
    expect(parseRoute("/work/")).toEqual({ page: "work" });
    expect(parseRoute("/sessions")).toEqual({ page: "actions" });
  });

  test("keep the selected node and call of a Session in the query, with ids that hold colons and slashes", () => {
    const sessionId = "ses_01JZ8Q4V6X2M9R3T5W7Y1A3C5E";
    const call = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const routes: Route[] = [
      { page: "session", sessionId, node: { kind: "thread", id: "11111111-aaaa-4aaa-8aaa-000000000001" } },
      { page: "session", sessionId, node: { kind: "conversation", id: "claude:22222222/agent-a8b7" }, call },
      { page: "session", sessionId, node: { kind: "thread", id: "thread:delegated-task:command%3Amcp%3A51" } },
    ];
    for (const route of routes) {
      const path = routePath(route);
      const [pathname, search] = path.split("?");
      expect(pathname).toBe(`/sessions/${sessionId}`);
      expect(parseRoute(pathname!, `?${search}`)).toEqual(route);
    }
    expect(routePath(routes[1]!)).toBe(`/sessions/${sessionId}?node=conversation%3Aclaude%3A22222222%2Fagent-a8b7&call=${call}`);
  });

  test("read a Session query value that breaks its rule as not set", () => {
    const sessionId = "ses_01JZ8Q4V6X2M9R3T5W7Y1A3C5E";
    expect(parseRoute(`/sessions/${sessionId}`, "?node=planet:x&call=0f0e0d0c-0b0a-4908-8706-050403020100")).toEqual({ page: "session", sessionId });
    expect(parseRoute(`/sessions/${sessionId}`, "?node=thread:t1&call=not-a-uuid")).toEqual({ page: "session", sessionId, node: { kind: "thread", id: "t1" } });
    expect(parseRoute(`/sessions/${sessionId}`, "?call=0f0e0d0c-0b0a-4908-8706-050403020100")).toEqual({ page: "session", sessionId });
    // Local mode has no Session pages: a Session route with a selection still shows the Action log.
    expect(localRoute(parseRoute(`/sessions/${sessionId}`, "?node=thread:t1"))).toEqual({ page: "actions" });
  });

  test("show the Work tab in server mode for the pages it does not have, and keep the run page", () => {
    expect(serverRoute(parseRoute("/"))).toEqual({ page: "work" });
    expect(serverRoute(parseRoute("/traces/canvas"))).toEqual({ page: "work" });
    expect(serverRoute(parseRoute("/nowhere"))).toEqual({ page: "work" });
    expect(serverRoute(parseRoute("/workflows"))).toEqual({ page: "workflows" });
    expect(serverRoute(parseRoute("/runs/archon/c5993f42-7c8b"))).toEqual({ page: "runs", run: { engine: "archon", runId: "c5993f42-7c8b" } });
  });

  test("show the Action log in local mode for the Session pages, and keep its own pages", () => {
    for (const path of ["/work", "/workflows", "/sessions/ses_01JZ8Q4V6X2M9R3T5W7Y1A3C5E"]) {
      expect(localRoute(parseRoute(path))).toEqual({ page: "actions" });
    }
    expect(localRoute(parseRoute("/traces/canvas"))).toEqual({ page: "traces", projectId: "canvas" });
    expect(localRoute(parseRoute("/runs"))).toEqual({ page: "runs", run: null });
  });

  test("send an unknown path to the Action log", () => {
    expect(parseRoute("/nowhere")).toEqual({ page: "actions" });
    expect(parseRoute("/traces/a/b")).toEqual({ page: "actions" });
  });

  test("keep a malformed percent escape as written instead of throwing", () => {
    expect(parseRoute("/traces/%")).toEqual({ page: "traces", projectId: "%" });
    expect(parseRoute("/traces/%E0%A4%A")).toEqual({ page: "traces", projectId: "%E0%A4%A" });
    expect(parseRoute("/runs/archon/%")).toEqual({ page: "runs", run: { engine: "archon", runId: "%" } });
  });
});

describe("a route link click", () => {
  const plain = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  test("navigates in the page only on a plain left click", () => {
    expect(isPlainLeftClick(plain)).toBe(true);
    expect(isPlainLeftClick({ ...plain, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, altKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...plain, defaultPrevented: true })).toBe(false);
  });
});
