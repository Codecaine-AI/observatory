# Observatory

Observatory is a local development UI with three data sources:

- **The action log.** Every Codecaine MCP server (canvas-mcp, docs-mcp,
  prompt-kit-mcp) appends one record per tool call to a shared SQLite file,
  `~/.codecaine/action-log.sqlite`. `CODECAINE_ACTION_LOG` overrides the
  path. Observatory reads it through `@codecaine-ai/action-log` and never
  appends records. A missing file shows as an empty log and is not created.
- **Registered projects.** `registry.json` lists the harnesses Observatory
  health-checks, starts, stops, and proxies requests to.
- **Kernel traces.** Each registered project's kernel trace database
  (`dbPath`, else the `dbPath` of its kernel manifest). Observatory opens it
  read-only, so it works while the harness is offline.

Observatory has two pages. Choose one in the header:

- **Action log** (`/`).
- **Traces** (`/traces/:projectId`). Pick a project with its Traces button in
  the sidebar. The page lists the project's kernel sessions and opens one in
  `KernelTraceWorkspace` from the trace-viewer packages
  (`@codecaine-ai/agent-kernel-viewer-*`). A project with no trace database
  shows an empty list.

The Action log page lists records newest first (time, thread, agent, tool,
target, result) and filters by thread id and target. Click a thread or target
in the table to filter by it. A read returns at most 1000 records, the oldest
first, so the page says when it hit that cap. Filter to narrow it.

## API

- `GET /api/actions?thread=&target=&run=&since=&until=&limit=` returns
  `{ path, records }` from the action log. Filters combine with AND. `since`
  is inclusive, `until` is exclusive, and `limit` defaults to 1000.
- `GET /registry/projects` lists registered projects with liveness and launch
  state.
- `POST /registry/projects/:id/launch`, `POST /registry/projects/:id/stop`
  and `GET /registry/projects/:id/logs` drive the launcher.
- `GET /registry/kernels/:id/kernel/trace-sessions`,
  `GET /registry/kernels/:id/kernel/trace-sessions/:sessionId`,
  `GET /registry/kernels/:id/kernel/containers/:containerId/trace`,
  `GET /registry/kernels/:id/kernel/blobs/:hash` and
  `GET /registry/kernels/:id/kernel/runs/:runId/turns/:turn/context` read the
  project's trace database directly. A missing database returns
  `{ trace_sessions: [] }` for the list and 404 for the others.
- Every other `/registry/kernels/:id/kernel/*` path proxies to the project's
  `readApiBaseUrl`.

## Run

Observatory is not a Core workspace member. Its `@codecaine-ai/*`
dependencies are `link:` dependencies that resolve through `.bun-links`
(`bunfig.toml` sets `globalDir = "./.bun-links"`). Before `bun install`,
`.bun-links/node_modules/@codecaine-ai/` must hold a symlink for each one:

| Link | Target in Core |
|---|---|
| `action-log` | `annotations/packages/action-log` |
| `design-system` | `design-system` |
| `agent-kernel` | `agent-kernel/packages/kernel` |
| `agent-kernel-db` | `agent-kernel/packages/db` |
| `agent-kernel-protocol` | `agent-kernel/packages/protocol` |
| `agent-kernel-viewer-core` | `trace-viewer/packages/viewer-core` |
| `agent-kernel-viewer-ui` | `trace-viewer/packages/viewer-ui` |
| `agent-kernel-viewer-shell` | `trace-viewer/packages/viewer-shell` |
| `prompt-kit` | `prompt-kit/packages/prompt-kit` |

The viewer packages are TypeScript source. They resolve their own
dependencies from Core's `node_modules`, so run `bun install` at the Core root
first.

```sh
bun install
bun run dev
```

`bun run build` builds the UI into `src/ui/dist`.

Open <http://127.0.0.1:4891>. The API listens on
<http://127.0.0.1:4890>.

On startup, each project with `autoLaunch: true` is health-checked and its
harness is started when offline. Opening Observatory is therefore enough to
bring the registered Canvas, Simple Research, and Prompt Kit harnesses online;
no harness terminals are required.

## Register a project

Edit the machine-local `registry.json` and add an entry to `projects`:

```json
{
  "id": "my-project",
  "name": "My Project",
  "kernelRoot": "../my-project/.agent-kernel",
  "dbPath": null,
  "catalogRoots": ["../my-project/src/agent-catalog"],
  "readApiBaseUrl": "http://127.0.0.1:8788",
  "viewerBaseUrl": null,
  "extensionPackage": null,
  "launchCommand": "bun run --cwd ../my-project api",
  "autoLaunch": true,
  "writable": true
}
```

Relative paths resolve from the directory containing `registry.json`.
`launchCommand` uses the same base: Observatory passes the command to a
non-login system shell with the directory containing `registry.json` as its
working directory and inherits Observatory's environment except for the
generic listener variables `PORT`, `HOST`, and `HOSTNAME`. Set a
harness-specific variable or an inline environment assignment in
`launchCommand` when a project needs a non-default listener. `autoLaunch`
defaults to `false`; when true, Observatory starts the command only if the
project's `/health` endpoint is not already live.

Observatory only stops processes it launched. A harness that was already live
remains unmanaged, and Observatory will never stop or replace it. Harnesses
remain the sole writers of prompt and catalog state; the launcher only owns
their process lifecycle.

`registry.example.json` is a resettable starting point; `registry.json` stays
untracked because its paths and ports are machine-local.
