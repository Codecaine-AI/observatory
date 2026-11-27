# Agent notes

## Test commands
Run every command from the repo root. Observatory is not a core workspace member. Install per the README: run `bun install` at the core root, create the `.bun-links/node_modules/@codecaine-ai/*` symlinks, then run `bun install` here.

**Tier 1, every change:** `bun run typecheck`, then the focused command for each changed test or its owner: `bun test <file>`, for example `bun test test/router.test.ts`.

**Tier 2, before a PR:** there is no changed-files gate and no CI. Diff base: `origin/main`. Run the full suite: `bun test` (11 files, 109 tests, about 3 s). The areas below say which test files own which code:

| Area | Owns | Tests |
|---|---|---|
| `src/server` API | Elysia app, kernel and prompt-edit passthrough, action log ingest, trace routes, local and server modes | `test/server.test.ts`, `test/server-mode.test.ts`, `test/server-entry.test.ts` |
| `src/server` launcher and registry | Project registry, health checks, harness launch | `test/registry.test.ts`, `test/launcher.test.ts`, `test/launcher-routes.test.ts` |
| `src/server` engine runs and queries | Engine run settings and routes, ClickHouse query queue | `test/engine-runs.test.ts`, `test/query-limit.test.ts` |
| `src/ui` | Router, run list and run page, Traces page project | `test/router.test.ts`, `test/runs-page.test.ts`, `test/traces-project.test.ts` |

Routing rules:
- Any change in `src/` runs the full suite and `bun run typecheck`.
- Observatory imports `@codecaine-ai/action-log`, the agent-kernel packages, the trace-viewer packages, `design-system` and `prompt-kit`. A change in one of those also runs this suite. No core package imports Observatory.
- A change only in `docs/`, `deploy/` or `*.md` runs no tests.

**Tier 3, before a big merge:** `bun run typecheck` and `bun test`.

**Keeper tests:** these are the only proof of a user flow. A prune must keep them, test by test.

| Flow | Keeper |
|---|---|
| Server mode reads runs from ClickHouse | `test/server-mode.test.ts` "reads the run list from ClickHouse" |
| Flagged projects launch when the app starts | `test/launcher-routes.test.ts` "auto-launches flagged projects when the app starts" |
| The Actions page reads one thread's action log | `test/server.test.ts` "returns the records of one thread from the shared action log" |
| Local mode serves traces from SQLite | `test/server.test.ts` "serves session list, detail, container trace, and blobs from SQLite" |
| A plain left click on a route link navigates in the page | `test/router.test.ts` "navigates in the page only on a plain left click" |

**Known failures on main:** `loadRegistry > loads the live registry with the Prompt Kit project` reads `registry.json`, a gitignored local file. It fails in any checkout without that file.

**Quarantine:** none. Each entry needs the test title, an owner and an expiry date.
