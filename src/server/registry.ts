import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface RegistryProjectInput {
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

export interface RegistryFile {
  registryVersion: 1;
  projects: RegistryProjectInput[];
}

export interface KernelManifest {
  manifestVersion?: 1 | 2;
  kernelId: string;
  displayName: string;
  piSessionsDir: string;
  kernelRoot?: string;
  dbPath?: string;
  catalogRoots?: string[];
  readApiBaseUrl?: string;
  viewerBaseUrl?: string;
}

export interface ResolvedRegistryProject {
  id: string;
  name: string;
  kernelId: string;
  kernelRoot: string;
  dbPath: string;
  catalogRoots: string[];
  readApiBaseUrl: string | null;
  viewerBaseUrl: string | null;
  extensionPackage: string | null;
  launchCommand: string | null;
  autoLaunch: boolean;
  writable: boolean;
  manifest: KernelManifest | null;
}

export interface LoadedRegistry {
  path: string;
  directory: string;
  registryVersion: 1;
  projects: ResolvedRegistryProject[];
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function resolveFrom(baseDirectory: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

async function readManifest(kernelRoot: string): Promise<KernelManifest | null> {
  const manifestPath = join(kernelRoot, "kernel.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Unable to read kernel manifest at ${manifestPath}: ${String(error)}`,
    );
  }

  let manifest: Partial<KernelManifest>;
  try {
    manifest = JSON.parse(raw) as Partial<KernelManifest>;
  } catch (error) {
    throw new Error(
      `Kernel manifest at ${manifestPath} is not valid JSON: ${String(error)}`,
    );
  }

  for (const field of ["kernelId", "displayName", "piSessionsDir"] as const) {
    assertNonEmptyString(manifest[field], `Kernel manifest "${field}"`);
  }

  if (
    manifest.manifestVersion !== undefined
    && manifest.manifestVersion !== 1
    && manifest.manifestVersion !== 2
  ) {
    throw new Error(
      `Kernel manifest at ${manifestPath} has unsupported manifestVersion ${manifest.manifestVersion}`,
    );
  }

  return manifest as KernelManifest;
}

function validateProject(
  input: RegistryProjectInput,
  index: number,
): RegistryProjectInput {
  assertNonEmptyString(input.id, `projects[${index}].id`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) {
    throw new Error(
      `projects[${index}].id must be a lowercase slug (received "${input.id}")`,
    );
  }
  assertNonEmptyString(input.name, `projects[${index}].name`);
  assertNonEmptyString(input.kernelRoot, `projects[${index}].kernelRoot`);
  if (
    input.catalogRoots !== undefined
    && !input.catalogRoots.every(
      (root) => typeof root === "string" && root.length > 0,
    )
  ) {
    throw new Error(`projects[${index}].catalogRoots must contain paths`);
  }
  if (
    input.launchCommand !== undefined
    && input.launchCommand !== null
    && (typeof input.launchCommand !== "string"
      || input.launchCommand.trim().length === 0)
  ) {
    throw new Error(
      `projects[${index}].launchCommand must be a non-empty string or null`,
    );
  }
  if (
    input.autoLaunch !== undefined
    && typeof input.autoLaunch !== "boolean"
  ) {
    throw new Error(`projects[${index}].autoLaunch must be a boolean`);
  }
  return input;
}

export async function loadRegistry(
  registryPath = resolve(process.cwd(), "registry.json"),
): Promise<LoadedRegistry> {
  const absolutePath = resolve(registryPath);
  const directory = dirname(absolutePath);
  let parsed: Partial<RegistryFile>;

  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8")) as Partial<RegistryFile>;
  } catch (error) {
    throw new Error(`Unable to load registry at ${absolutePath}: ${String(error)}`);
  }

  if (parsed.registryVersion !== 1) {
    throw new Error(
      `Registry at ${absolutePath} has unsupported registryVersion ${String(parsed.registryVersion)}`,
    );
  }
  if (!Array.isArray(parsed.projects)) {
    throw new Error(`Registry at ${absolutePath} must contain a projects array`);
  }

  const seen = new Set<string>();
  const projects: ResolvedRegistryProject[] = [];
  for (const [index, rawProject] of parsed.projects.entries()) {
    const input = validateProject(rawProject, index);
    if (seen.has(input.id)) {
      throw new Error(`Registry project id "${input.id}" is duplicated`);
    }
    seen.add(input.id);

    const configuredKernelRoot = resolveFrom(directory, input.kernelRoot);
    const manifest = await readManifest(configuredKernelRoot);
    const manifestKernelRoot = manifest?.kernelRoot
      ? resolveFrom(directory, manifest.kernelRoot)
      : configuredKernelRoot;
    // Registry values are authoritative. The v2 manifest only fills fields
    // omitted from the machine-local registry.
    const kernelRoot = configuredKernelRoot || manifestKernelRoot;
    const dbPath = input.dbPath
      ? resolveFrom(directory, input.dbPath)
      : manifest?.dbPath
        ? resolveFrom(directory, manifest.dbPath)
        : join(kernelRoot, "trace.db");
    const catalogRoots =
      input.catalogRoots && input.catalogRoots.length > 0
        ? input.catalogRoots.map((root) => resolveFrom(directory, root))
        : (manifest?.catalogRoots ?? []).map((root) =>
            resolveFrom(directory, root),
          );

    projects.push({
      id: input.id,
      name: input.name,
      kernelId: manifest?.kernelId ?? input.id,
      kernelRoot,
      dbPath,
      catalogRoots,
      readApiBaseUrl:
        input.readApiBaseUrl ?? manifest?.readApiBaseUrl ?? null,
      viewerBaseUrl: input.viewerBaseUrl ?? manifest?.viewerBaseUrl ?? null,
      extensionPackage: input.extensionPackage ?? null,
      launchCommand: input.launchCommand ?? null,
      autoLaunch: input.autoLaunch ?? false,
      writable: input.writable ?? false,
      manifest,
    });
  }

  return {
    path: absolutePath,
    directory,
    registryVersion: 1,
    projects,
  };
}
