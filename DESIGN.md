# Observatory — Design v0

Observatory is a standalone development tool and a top-level peer of the other
Core repositories. It registers kernel harnesses ("projects") and gives one
unified surface to browse their agents, prompts, and traces — an extended trace
viewer and prompt workbench combined, instead of one bespoke viewer per
harness.

Non-goals: Observatory is not Spectre, not a product, and not a runtime. It
never spawns agents and never becomes a dependency of any harness. Harnesses
stay runnable and viewable on their own.

## Position

- New peer repo: `Core/observatory`. Consumes `@agent-kernel/*` viewer/db
  packages and `@codecaine-ai/prompt-kit` via `link:` dependencies. Its
  `src/ui/vite.config.ts` handles linked TypeScript source with fs allowances,
  React dedup, and prebundle exclusions.
- Stack: Bun + TypeScript. Server: Elysia (match canvas-agent). UI: Vite +
  React using `@agent-kernel/viewer-shell` / `viewer-ui` / `viewer-core`.
- Ports: API `4890`, UI dev server `4891` (unused across Core; existing usage:
  2455, 3998, 3999, 4173, 4800–4811, 4820, 4830, 5174, 8788).
- `scripts/dev.ts` launcher spawns API + UI, kills both on exit (same pattern
  as `agent-kernel/examples/simple-research-kernel/scripts/dev.ts`).

## Registry

`registry.json` at repo root, machine-local, gitignored. `registry.example.json`
is committed. Relative paths resolve against the registry file's directory.

Maintenance is tool-assisted since 2026-08-07: `scripts/sync-registry.ts`
(`bun run registry:check|sync`) discovers member-repo kernel manifests and
appends missing projects; it is registry-authoritative — existing entries are
never modified, drift is only reported (Core's doctor runs the check). The
`agent-kernel` project (the "core kernel": generic catalog + core-harness on
:4860 + TUI-session ingest) registers like any other; see
`agent-kernel/docs/10-system-design/70-harness-model.md`.

```jsonc
{
  "registryVersion": 1,
  "projects": [
    {
      "id": "canvas",                      // stable slug, unique
      "name": "Canvas",                    // sidebar display name
      "kernelRoot": "../canvas/.agent-kernel",
      "dbPath": null,                      // default: <kernelRoot>/trace.db
      "catalogRoots": ["../canvas/packages/canvas-agent/src/catalog"],
      "readApiBaseUrl": "http://127.0.0.1:4820",
      "viewerBaseUrl": "http://127.0.0.1:4830",  // optional, informational
      "extensionPackage": null,            // optional module specifier, see Extensions
      "launchCommand": null,               // reserved for later start/stop support
      "writable": true                     // gate prompt-editing UI
    }
  ]
}
```

Initial seeded projects: `canvas` (above) and `simple-research`
(`../agent-kernel/examples/simple-research-kernel/.agent-kernel`,
readApiBaseUrl `http://127.0.0.1:8788`).

## Kernel manifest v2

Owned by `@agent-kernel/db` (`packages/db/src/manifest.ts`). Written by each
harness on boot. v2 adds self-description so a harness can be registered from
its manifest alone; Observatory treats registry entries as authoritative and
manifests as fallback/enrichment.

```ts
{
  manifestVersion: 2,
  kernelId: string,
  displayName: string,
  piSessionsDir: string,
  kernelRoot: string,        // abs path to the .agent-kernel directory
  dbPath: string,            // abs path to trace.db
  catalogRoots: string[],    // abs paths to agent-catalog roots
  readApiBaseUrl?: string,   // harness read/catalog API (distinct from viewer)
  viewerBaseUrl?: string
}
```

- Write must be atomic (tmp file + rename); today's write is a direct
  overwrite.
- Readers must accept v1 manifests (missing v2 fields → undefined).

## Server (port 4890)

One Bun/Elysia process. Per registered project it maintains:

- A read-only SQLite handle on `dbPath`: `new Database(path, { readonly: true })`
  (pattern: `agent-kernel/packages/kernel/src/transcript-recovery/backfill.test.ts:129`).
  Never call `ensureKernelObservabilitySchema()` on this handle, never use
  `immutable=1` (DBs are live WAL), keep read transactions short. Missing DB
  file → project shows as "no traces yet", not an error.
- A liveness probe of `readApiBaseUrl` (periodic + on-demand) → `live` flag.

Routes (same-origin for the UI):

| Route | Backing |
|---|---|
| `GET /registry/projects` | registry + manifest + live flag |
| `GET /registry/kernels/:id/kernel/trace-sessions` | local read-only DB |
| `GET /registry/kernels/:id/kernel/trace-sessions/:sessionId` | local read-only DB |
| `GET /registry/kernels/:id/kernel/containers/:containerId/trace` | local read-only DB |
| `GET /registry/kernels/:id/kernel/blobs/:hash` | local read-only DB |
| `GET /registry/kernels/:id/kernel/runs/:runId/turns/:turnNumber/context` | local read-only DB |
| `ANY /registry/kernels/:id/kernel/**` not matched above | reverse-proxy to the live harness's kernel API (including catalog and app-specific viewer routes); `503 { live: false }` when down |

Concrete local-DB routes take precedence over the passthrough, including when a
trace record is absent. Catalog mutations are reverse-proxied only when the
project is `writable`; reads and other app-specific viewer routes require only
a live harness.

Implementation preference for the local-DB routes: reuse the service factories
behind `packages/kernel/src/read-api.ts` with a configurable prefix if they can
be constructed from a DB handle without a running kernel; otherwise implement
thin handlers over `@agent-kernel/db` query helpers returning the DTOs
`@agent-kernel/viewer-core` expects (`viewer-core/src/api.ts` path constants
are the contract).

## UI (port 4891)

Sidebar → content layout:

```
Projects (from /registry/projects, live/offline badge)
└─ <project>
   ├─ Agents   → agent list (catalog API) → prompt lab
   └─ Traces   → session list → trace workspace
```

- Traces: host fetches sessions/detail per project, builds spans with
  `buildTraceSpans()` from viewer-core, mounts `KernelTraceWorkspace` with
  `apiBase = /registry/kernels/:id` and `key={projectId}` (the shared viewer
  and extensions append `/kernel/**`; the key avoids
  cross-kernel selection/expansion bleed; equal IDs across kernels are
  possible).
- Agents: `AgentPromptLabContainer` from viewer-ui with
  `baseUrl = /registry/kernels/:id/kernel`, `agentName` from the catalog list.
  Offline projects show agents as unavailable with the reason (harness not
  running) rather than an empty state.
- Editing: enabled only when project is `writable` and live; saves go through
  the harness's existing `PUT /kernel/catalog/agents/:name/prompt` (validated,
  canonicalized, revisioned, hot-swapped there).

## Extensions v0

See the [viewer layering policy](docs/VIEWER-LAYERING.md).

Per-harness rich rendering ships as code the harness exports; Observatory
always falls back to generic rendering (unknown `app:*` events already degrade
to generic cards + Raw Details in viewer-ui).

```ts
// harness package.json:  "exports": { "./viewer-extension": "./src/viewer-extension/index.ts" }
export interface ObservatoryViewerExtension {
  appId: string;  // matches registry project id
  createDetailBlockProvider(ctx: { apiBase: string }): DetailBlockProvider; // viewer-ui blocks.ts type
}
```

- Registry `extensionPackage` names the module; Observatory imports it in the
  UI build, keyed by project id. Load failure → warn + generic fallback.
- First real extension: canvas-agent's existing `detailBlockProvider`
  (thinking / program / render-thumbnail blocks, currently in
  `canvas/packages/canvas-agent/src/viewer/components/TraceDetailView.tsx`),
  parameterized by `apiBase` instead of its hardcoded API base.
- Cleanup that unblocks neutrality: the rich `app:board-render` renderer is
  currently hardcoded in shared viewer-ui
  (`detail-panel/rendererRegistry.ts` → `renderers/BoardRenderBody.tsx`); it
  moves into the canvas extension so shared viewer-ui stays app-neutral.

## Workstreams

1. `@agent-kernel/db`: manifest v2 + atomic write + `openKernelDatabaseReadOnly`
   helper; update simple-research server's manifest write.
2. `@agent-kernel/kernel` + viewer-core/ui: catalog API gaps — expose stored
   revision documents (`GET .../revisions/:hash/document`) and optimistic
   concurrency on prompt saves (`expectedHash` → 409 with current hash).
3. Observatory itself: scaffold, server, UI (this repo).
4. Canvas extension package + `BoardRenderBody` relocation out of viewer-ui.

Follow-up after all land: canvas `bootKernelDatabase` writes manifest v2; wire
canvas `extensionPackage` into the seeded registry; adopt `expectedHash` in the
prompt-lab save path.
