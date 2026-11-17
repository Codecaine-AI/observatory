import { describe, expect, test } from "bun:test";

import { isPlainLeftClick, parseRoute, routePath, type Route } from "../src/ui/router";

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

  test("send an unknown path to the Action log", () => {
    expect(parseRoute("/nowhere")).toEqual({ page: "actions" });
    expect(parseRoute("/traces/a/b")).toEqual({ page: "actions" });
  });

  test("keep a malformed percent escape as written instead of throwing", () => {
    expect(parseRoute("/traces/%")).toEqual({ page: "traces", projectId: "%" });
    expect(parseRoute("/traces/%E0%A4%A")).toEqual({ page: "traces", projectId: "%E0%A4%A" });
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
