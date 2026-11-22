import { describe, expect, test } from "bun:test";

import { runSubtitle } from "../src/ui/pages/RunsPage";

describe("the run list", () => {
  test("names each run by its short id and its start time in UTC, in both modes", () => {
    expect(runSubtitle({ runId: "c5993f42-7c8b-4c1d-9e0f-000000000001", startedAt: "2026-11-17T11:53:37.000Z" })).toBe(
      "run c5993f42 · 2026-11-17 11:53:37 UTC",
    );
    // A start time with an offset reads as the same instant in UTC.
    expect(runSubtitle({ runId: "c5993f42-7c8b", startedAt: "2026-11-17T05:53:37-06:00" })).toBe("run c5993f42 · 2026-11-17 11:53:37 UTC");
    expect(runSubtitle({ runId: "c5993f42-7c8b", startedAt: null })).toBe("run c5993f42");
  });
});

describe("the run page in server mode", () => {
  test("links a run to its Session with the run node selected, and shows no link when no Session holds it", async () => {
    const { runSessionRoute } = await import("../src/ui/ServerApp");
    const { routePath } = await import("../src/ui/router");
    const node = { kind: "run" as const, id: "(archon, c5993f42-7c8b)" };
    const session = { id: "ses_0FIXTURE000000000000000001", title: "Made-up Session", phase: "run", statusGroup: "active" };
    const route = runSessionRoute({ node, runNode: null, session });
    expect(route).toEqual({ page: "session", sessionId: session.id, node });
    expect(routePath(route!)).toBe("/sessions/ses_0FIXTURE000000000000000001?node=run%3A%28archon%2C+c5993f42-7c8b%29");
    expect(runSessionRoute({ node, runNode: null, session: null })).toBeNull();
  });
});
