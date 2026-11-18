import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/server/index.ts");
const directories: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const child of processes.splice(0)) child.kill();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Starts the real entry point in a temp folder with only the given variables. */
function start(env: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "observatory-entry-"));
  directories.push(directory);
  const child = Bun.spawn([process.execPath, ENTRY], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "", HOME: directory, OBSERVATORY_API_PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(child);
  return { child, directory };
}

/** Reads stdout until a line holds `text`, and returns what it read. */
async function readUntil(stream: ReadableStream<Uint8Array>, text: string): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return output;
    output += decoder.decode(value);
    if (output.includes(text)) return output;
  }
}

describe("the server entry point", () => {
  test("exits with code 1 in server mode when TRACES_SQL_PASSWORD is empty", async () => {
    const { child } = start({ OBSERVATORY_MODE: "server", TRACES_SQL_PASSWORD: "" });

    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr as ReadableStream).text()).toContain("TRACES_SQL_PASSWORD");
  });

  test("starts in server mode with no registry.json, where local mode fails", async () => {
    const server = start({ OBSERVATORY_MODE: "server", TRACES_SQL_PASSWORD: "test-only" });

    const output = await readUntil(server.child.stdout as ReadableStream<Uint8Array>, "Registry: none (server mode)");

    expect(output).toContain("Mode: server");
    expect(output).toContain("Registry: none (server mode)");
    const local = start({});
    expect(await local.child.exited).not.toBe(0);
  });
});
