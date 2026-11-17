import { describe, expect, test } from "bun:test";

import { parseRoute, routePath, type Route } from "../src/ui/router";

describe("the page routes", () => {
  test("read and write the Runs page with and without an open run", () => {
    const routes: [string, Route][] = [
      ["/", { page: "actions" }],
      ["/traces/simple-research", { page: "traces", projectId: "simple-research" }],
      ["/runs", { page: "runs", run: null }],
      ["/runs/archon/c5993f42-7c8b", { page: "runs", run: { engine: "archon", runId: "c5993f42-7c8b" } }],
    ];
    for (const [path, route] of routes) {
      expect(parseRoute(path)).toEqual(route);
      expect(routePath(route)).toBe(path);
    }
  });
});
