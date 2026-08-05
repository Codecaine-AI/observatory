import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { loadRegistry } from "../src/server/registry";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "observatory-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRegistry", () => {
  test("loads the live registry with the Prompt Kit project", async () => {
    const registry = await loadRegistry(
      resolve(import.meta.dir, "..", "registry.json"),
    );
    const promptKit = registry.projects.find(
      (project) => project.id === "prompt-kit",
    );

    expect(promptKit).toMatchObject({
      name: "Prompt Kit",
      readApiBaseUrl: "http://127.0.0.1:4850",
      viewerBaseUrl: null,
      launchCommand: "bun run --cwd ../prompt-kit dev:agent",
      autoLaunch: true,
      writable: true,
    });
    expect(
      promptKit?.catalogRoots.map((root) => root.replaceAll("\\", "/")),
    ).toEqual([
      expect.stringContaining("/prompt-kit/packages/prompt-kit-agent/catalog"),
    ]);
  });

  test("resolves registry paths and enriches omitted fields from a v2 manifest", async () => {
    const directory = makeTemporaryDirectory();
    const kernelRoot = join(directory, "kernel", ".agent-kernel");
    Bun.write(
      join(kernelRoot, "kernel.json"),
      JSON.stringify({
        manifestVersion: 2,
        kernelId: "fixture-kernel",
        displayName: "Fixture manifest",
        piSessionsDir: join(kernelRoot, "pi-sessions"),
        kernelRoot,
        dbPath: join(kernelRoot, "manifest-trace.db"),
        catalogRoots: [join(directory, "manifest-catalog")],
        readApiBaseUrl: "http://127.0.0.1:9000",
      }),
    );
    const registryPath = join(directory, "registry.json");
    await Bun.write(
      registryPath,
      JSON.stringify({
        registryVersion: 1,
        projects: [
          {
            id: "fixture",
            name: "Fixture",
            kernelRoot: "./kernel/.agent-kernel",
            dbPath: "./explicit.db",
            catalogRoots: ["./explicit-catalog"],
            writable: true,
          },
        ],
      }),
    );

    const registry = await loadRegistry(registryPath);
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0]).toMatchObject({
      id: "fixture",
      kernelId: "fixture-kernel",
      kernelRoot,
      dbPath: join(directory, "explicit.db"),
      catalogRoots: [join(directory, "explicit-catalog")],
      readApiBaseUrl: "http://127.0.0.1:9000",
      writable: true,
    });
  });

  test("accepts a v1 manifest and defaults dbPath beneath kernelRoot", async () => {
    const directory = makeTemporaryDirectory();
    const kernelRoot = join(directory, ".agent-kernel");
    writeFileSync(
      join(directory, "registry.json"),
      JSON.stringify({
        registryVersion: 1,
        projects: [
          {
            id: "legacy",
            name: "Legacy",
            kernelRoot: ".agent-kernel",
          },
        ],
      }),
    );
    await Bun.write(
      join(kernelRoot, "kernel.json"),
      JSON.stringify({
        kernelId: "legacy-kernel",
        displayName: "Legacy",
        piSessionsDir: join(kernelRoot, "pi-sessions"),
      }),
    );

    const registry = await loadRegistry(join(directory, "registry.json"));
    expect(registry.projects[0]?.dbPath).toBe(join(kernelRoot, "trace.db"));
    expect(registry.projects[0]?.kernelId).toBe("legacy-kernel");
    expect(registry.projects[0]?.autoLaunch).toBe(false);
  });

  test("rejects duplicate project ids", async () => {
    const directory = makeTemporaryDirectory();
    const registryPath = join(directory, "registry.json");
    await Bun.write(
      registryPath,
      JSON.stringify({
        registryVersion: 1,
        projects: [
          { id: "same", name: "One", kernelRoot: "./one" },
          { id: "same", name: "Two", kernelRoot: "./two" },
        ],
      }),
    );

    expect(loadRegistry(registryPath)).rejects.toThrow("duplicated");
  });
});
