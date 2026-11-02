import { describe, expect, test } from "bun:test";
import { agentPath, parseRoute } from "./router";

describe("agent document routes", () => {
  test("restores each document view from its URL", () => {
    for (const view of ["system", "context", "state", "tools"] as const) {
      expect(parseRoute(agentPath("canvas", "layout-editor", view))).toEqual({
        kind: "agent", projectId: "canvas", agentName: "layout-editor", view,
      });
    }
  });

  test("keeps old links working and falls back for unknown views", () => {
    for (const suffix of ["", "/invalid"]) {
      expect(parseRoute(`/canvas/agent/layout-editor${suffix}`)).toEqual({
        kind: "agent", projectId: "canvas", agentName: "layout-editor", view: "system",
      });
    }
  });

  test("preserves encoded project and agent names", () => {
    expect(parseRoute(agentPath("my project", "editor/preview", "context"))).toEqual({
      kind: "agent", projectId: "my project", agentName: "editor/preview", view: "context",
    });
  });
});
