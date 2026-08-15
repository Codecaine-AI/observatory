#!/usr/bin/env bun
/**
 * Registry sync: Core members.json -> observatory registry.json.
 *
 * Discovers `.agent-kernel/kernel.json` manifests across the Core member
 * repos and compares them against the machine-local registry. The registry
 * is authoritative (same philosophy as src/server/registry.ts): this tool
 * ADDS projects the registry is missing and REPORTS drift on existing
 * entries — it never overwrites a hand-edited value.
 *
 * Matching is by resolved kernelRoot, not by id: registry ids are
 * hand-chosen slugs (e.g. "canvas") while manifests carry kernelIds
 * (e.g. "canvas-agent").
 *
 * Usage:
 *   bun scripts/sync-registry.ts             # report only, exit 0
 *   bun scripts/sync-registry.ts --check     # exit 1 on missing/drifted (doctor)
 *   bun scripts/sync-registry.ts --write     # append missing projects
 *   bun scripts/sync-registry.ts --registry <path>   # non-default registry file
 *   bun scripts/sync-registry.ts --core <path>       # non-default Core root
 *
 * Dependency-free on purpose (node:fs / node:path only) so the Core doctor
 * can invoke it even when observatory/node_modules is absent.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// CLI

const OBSERVATORY = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);

function flagValue(name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} requires a path argument`);
    process.exit(2);
  }
  return value;
}

const CHECK = args.includes("--check");
const WRITE = args.includes("--write");
if (CHECK && WRITE) {
  console.error("--check and --write are mutually exclusive");
  process.exit(2);
}
const REGISTRY_PATH = resolve(flagValue("--registry") ?? join(OBSERVATORY, "registry.json"));
const CORE = resolve(flagValue("--core") ?? resolve(OBSERVATORY, ".."));
const REGISTRY_DIR = dirname(REGISTRY_PATH);

// ---------------------------------------------------------------------------
// Types (mirrors src/server/registry.ts; kept standalone — see header)

interface RegistryProject {
  id: string;
  name: string;
  kernelRoot: string;
  dbPath?: string | null;
  catalogRoots?: string[];
  readApiBaseUrl?: string | null;
  viewerBaseUrl?: string | null;
  extensionPackage?: string | null;
  launchCommand?: string | null;
  autoLaunch?: boolean;
  writable?: boolean;
}

interface KernelManifest {
  kernelId: string;
  displayName: string;
  kernelRoot?: string;
  dbPath?: string;
  catalogRoots?: string[];
  readApiBaseUrl?: string;
  viewerBaseUrl?: string;
}

interface DiscoveredKernel {
  kernelRoot: string; // absolute path to the .agent-kernel directory
  memberDir: string; // member repo dir relative to Core
  manifest: KernelManifest;
}

// ---------------------------------------------------------------------------
// Discovery

/** Directory names never descended into. `reference`/`external` hold vendored
 * corpora and submodules (see Core scripts/doctor.ts IGNORES). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".vite",
  "reference",
  "external",
]);
const MAX_DEPTH = 8;

function findKernelManifests(dirAbs: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = join(dirAbs, entry.name);
    if (entry.name === ".agent-kernel") {
      if (existsSync(join(child, "kernel.json"))) out.push(child);
      continue; // never recurse into a kernel root
    }
    if (entry.name.startsWith(".")) continue;
    findKernelManifests(child, depth + 1, out);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function discoverKernels(): { kernels: DiscoveredKernel[]; problems: string[] } {
  const membersPath = join(CORE, "members.json");
  const members = readJson(membersPath) as { dir: string }[];
  const kernels: DiscoveredKernel[] = [];
  const problems: string[] = [];
  for (const member of members) {
    const memberAbs = join(CORE, member.dir);
    if (!existsSync(memberAbs)) continue;
    const roots: string[] = [];
    findKernelManifests(memberAbs, 0, roots);
    for (const kernelRoot of roots) {
      const manifestPath = join(kernelRoot, "kernel.json");
      let manifest: KernelManifest;
      try {
        manifest = readJson(manifestPath) as KernelManifest;
      } catch (error) {
        problems.push(`unparseable manifest: ${manifestPath} (${String(error)})`);
        continue;
      }
      if (typeof manifest.kernelId !== "string" || manifest.kernelId.length === 0) {
        problems.push(`manifest missing kernelId: ${manifestPath}`);
        continue;
      }
      kernels.push({ kernelRoot, memberDir: member.dir, manifest });
    }
  }
  return { kernels, problems };
}

// ---------------------------------------------------------------------------
// Registry comparison

function resolveFrom(baseDirectory: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

function relativize(absPath: string): string {
  const rel = relative(REGISTRY_DIR, absPath);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface DriftReport {
  id: string;
  lines: string[];
}

/** Registry-authoritative comparison: drift is reported only where the
 * registry EXPLICITLY sets a value that disagrees with the manifest. A null
 * or omitted registry field falls back to the manifest at load time (see
 * src/server/registry.ts) and therefore can never drift. */
function driftFor(entry: RegistryProject, kernel: DiscoveredKernel): DriftReport | null {
  const { manifest } = kernel;
  const lines: string[] = [];

  if (entry.dbPath) {
    const registryDb = resolveFrom(REGISTRY_DIR, entry.dbPath);
    const manifestDb = manifest.dbPath
      ? resolveFrom(REGISTRY_DIR, manifest.dbPath)
      : join(kernel.kernelRoot, "trace.db");
    if (registryDb !== manifestDb) {
      lines.push(`dbPath: registry ${registryDb} vs manifest ${manifestDb}`);
    }
  }
  for (const field of ["readApiBaseUrl", "viewerBaseUrl"] as const) {
    const registryValue = entry[field];
    const manifestValue = manifest[field];
    if (registryValue != null && manifestValue != null && registryValue !== manifestValue) {
      lines.push(`${field}: registry ${registryValue} vs manifest ${manifestValue}`);
    }
  }
  if (entry.catalogRoots && entry.catalogRoots.length > 0 && manifest.catalogRoots) {
    const registryRoots = entry.catalogRoots.map((root) => resolveFrom(REGISTRY_DIR, root)).sort();
    const manifestRoots = manifest.catalogRoots.map((root) => resolveFrom(REGISTRY_DIR, root)).sort();
    if (JSON.stringify(registryRoots) !== JSON.stringify(manifestRoots)) {
      lines.push(
        `catalogRoots: registry [${registryRoots.join(", ")}] vs manifest [${manifestRoots.join(", ")}]`,
      );
    }
  }

  return lines.length > 0 ? { id: entry.id, lines } : null;
}

function newEntryFor(kernel: DiscoveredKernel, takenIds: Set<string>): RegistryProject {
  const { manifest, kernelRoot } = kernel;
  let id = slugify(manifest.kernelId) || slugify(kernel.memberDir) || "kernel";
  let candidate = id;
  for (let n = 2; takenIds.has(candidate); n += 1) candidate = `${id}-${n}`;
  id = candidate;
  takenIds.add(id);

  const defaultDb = join(kernelRoot, "trace.db");
  const manifestDb = manifest.dbPath ? resolveFrom(REGISTRY_DIR, manifest.dbPath) : null;
  return {
    id,
    name: manifest.displayName ?? manifest.kernelId,
    kernelRoot: relativize(kernelRoot),
    dbPath: manifestDb && manifestDb !== defaultDb ? relativize(manifestDb) : null,
    catalogRoots: (manifest.catalogRoots ?? []).map((root) =>
      relativize(resolveFrom(REGISTRY_DIR, root)),
    ),
    readApiBaseUrl: manifest.readApiBaseUrl ?? null,
    viewerBaseUrl: manifest.viewerBaseUrl ?? null,
    extensionPackage: null,
    launchCommand: null,
    autoLaunch: false,
    writable: false,
  };
}

// ---------------------------------------------------------------------------
// Main

function main(): number {
  const { kernels, problems } = discoverKernels();

  let registry: { registryVersion: 1; projects: RegistryProject[] };
  if (existsSync(REGISTRY_PATH)) {
    const parsed = readJson(REGISTRY_PATH) as Partial<typeof registry>;
    if (parsed.registryVersion !== 1 || !Array.isArray(parsed.projects)) {
      console.error(`✗ ${REGISTRY_PATH} is not a registryVersion 1 file with a projects array`);
      return 2;
    }
    registry = parsed as typeof registry;
  } else {
    registry = { registryVersion: 1, projects: [] };
    console.log(`ℹ no registry at ${REGISTRY_PATH}${WRITE ? " — will create it" : ""}`);
  }

  const byKernelRoot = new Map(
    registry.projects.map((entry) => [resolveFrom(REGISTRY_DIR, entry.kernelRoot), entry]),
  );

  const missing: DiscoveredKernel[] = [];
  const drifted: DriftReport[] = [];
  for (const kernel of kernels) {
    const entry = byKernelRoot.get(kernel.kernelRoot);
    if (!entry) {
      missing.push(kernel);
      continue;
    }
    const drift = driftFor(entry, kernel);
    if (drift) drifted.push(drift);
    else console.log(`✓ ${entry.id}: registered (${relativize(kernel.kernelRoot)})`);
  }

  // Registry entries with no manifest on disk are legal (loader tolerates a
  // missing kernel.json) — surface them as info only.
  const discoveredRoots = new Set(kernels.map((kernel) => kernel.kernelRoot));
  for (const [root, entry] of byKernelRoot) {
    if (!discoveredRoots.has(root)) {
      console.log(`ℹ ${entry.id}: registry entry has no kernel.json on disk (${entry.kernelRoot})`);
    }
  }

  for (const problem of problems) console.log(`⚠ ${problem}`);
  for (const drift of drifted) {
    console.log(`⚠ ${drift.id}: registry differs from manifest (registry wins; not modified)`);
    for (const line of drift.lines) console.log(`    ${line}`);
  }

  if (missing.length > 0) {
    const takenIds = new Set(registry.projects.map((entry) => entry.id));
    const additions = missing.map((kernel) => newEntryFor(kernel, takenIds));
    for (const [index, addition] of additions.entries()) {
      const verb = WRITE ? "added" : "unregistered";
      console.log(`${WRITE ? "✓" : "✗"} ${addition.id}: ${verb} (${missing[index].kernelRoot})`);
    }
    if (WRITE) {
      registry.projects.push(...additions);
      writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
      console.log(`✓ wrote ${REGISTRY_PATH} (+${additions.length} project${additions.length === 1 ? "" : "s"})`);
    } else {
      console.log(`FIX: bun scripts/sync-registry.ts --write`);
    }
  } else if (kernels.length > 0) {
    console.log(`✓ all ${kernels.length} discovered kernels are registered`);
  } else {
    console.log("⚠ no kernel manifests discovered under Core members");
  }

  if (CHECK && (missing.length > 0 || drifted.length > 0)) return 1;
  return 0;
}

process.exit(main());
