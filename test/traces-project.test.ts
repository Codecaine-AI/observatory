import { describe, expect, test } from "bun:test";

import type { RegistryProject } from "../src/ui/api";
import { resolveTracesProject } from "../src/ui/tracesProject";

function project(id: string): RegistryProject {
  return {
    id,
    name: id,
    live: false,
    writable: false,
    extensionPackage: null,
    launchable: false,
    managed: { state: "idle" },
  };
}

describe("the Traces page project", () => {
  const projects = [project("alpha"), project("beta")];

  test("is the first project when the route names none", () => {
    expect(resolveTracesProject(projects, null, false)).toEqual({
      kind: "project",
      project: projects[0]!,
    });
  });

  test("is the named project when the registry has it", () => {
    expect(resolveTracesProject(projects, "beta", false)).toEqual({
      kind: "project",
      project: projects[1]!,
    });
  });

  test("is not found for an unknown id, never another project", () => {
    expect(resolveTracesProject([project("alpha")], "beta", false)).toEqual({
      kind: "not-found",
      projectId: "beta",
    });
  });

  test("is not found when the named project leaves the registry on a refresh", () => {
    const before = resolveTracesProject(projects, "beta", false);
    const after = resolveTracesProject([project("alpha")], "beta", true);
    expect(before.kind).toBe("project");
    expect(after).toEqual({ kind: "not-found", projectId: "beta" });
  });

  test("waits for the first registry read before it says not found", () => {
    expect(resolveTracesProject([], "beta", true)).toEqual({ kind: "loading" });
    expect(resolveTracesProject([], null, false)).toEqual({ kind: "none" });
  });
});
