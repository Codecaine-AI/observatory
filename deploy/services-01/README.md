# Observatory on services-01

Observatory runs in server mode (`OBSERVATORY_MODE=server`) on services-01 as the services user, on `127.0.0.1:8830`. Caddy serves `https://traces.lascari.dev` from it.

Server mode is read-only:
- It serves `/health`, the engine run routes, the Archon home's kernel routes, the Session routes, and an empty project list.
- It reads the runs and the Sessions from the trace ClickHouse as `traces_ro`, and it reads no registry.
- It mounts no launch, stop, logs, kernel proxy, or actions route, and it starts no liveness poll and no auto-launch.

## Routes

Caddy sends only `/api/*` and `/registry/*` to the API. It serves every other path from the built UI, so the UI reads the mode from `/api/health`.

| Route | Answer |
|---|---|
| `GET /health`, `GET /api/health` | `{"status":"ok","mode":"server","projects":0}`. The UI picks its shell from `mode` |
| `GET /registry/projects` | `{"projects":[]}` |
| `GET /api/engine-runs` and its 2 sub-routes | The workflow engine runs and their calls |
| `GET /api/archon-home/kernel/*` | The kernel trace routes on the home's `.agent-kernel/trace.db` |
| `GET /api/sessions` | The Session list, last active first, at most 2,000. Filters: `from`, `to`, `machine`, `harness`, `phase`, `search` |
| `GET /api/sessions/:sessionId/tree` | One Session as a tree of its nodes |
| `GET /api/node-calls?kind=&id=` | 100 calls of one node: the first ones, or `after=`, `from=` or `before=` a cursor, or around one call with `call=`. `session=` answers 404 for a node of another Session |
| `GET /api/calls/:callId` | The prompt, answer and usage of one call. `?recent=N` gives the newest N messages and the answer first |
| `GET /api/calls/:callId/messages?from=&to=` | The older history of one call, at most 500 messages for each page |
| `GET /api/orphans` | The nodes with no parent, and the count of calls with no node |
| `GET /api/unlinked-calls` | The calls with no node, grouped by cause |
| `GET /api/engine-runs/:engine/:runId/session` | The run node of a workflow run and its Session |
| `GET /api/status` | The age of each source and each collector heartbeat |
| `GET /api/workflows` | The workflow runs, grouped by workflow, from the newest 5,000 |

The UI in server mode has a left sidebar with Work and Workflows:

| Page | Path |
|---|---|
| Work: the Sessions, and the nodes with no parent | `/` and `/work` |
| One Session as a tree | `/sessions/:sessionId` |
| Workflows: the runs by workflow | `/workflows` |
| One run | `/runs/:engine/:runId` |

## Layout

| Path | What It Holds |
|---|---|
| `/Users/services/deploy/codecaine-core/a` and `b` | 2 full checkouts of codecaine-core and its 9 members, with `node_modules` and the built UI |
| `/Users/services/deploy/codecaine-core/current` | A link to the slot that runs |
| `/Users/services/.local/share/services-fleet/observatory/deployed` | One `repo sha` line for each of the 10 repos of the running slot |
| `/Users/services/.local/share/services-fleet/observatory/failed` | The set of commits whose deploy failed. The poll skips it until you delete the file |
| `/Users/services/Library/Logs/services-fleet/observatory/` | `deploy.log`, `autodeploy.log`, `api.out.log`, `api.err.log` |

| File | Job |
|---|---|
| `deploy.sh` | Builds the idle slot, checks it on `127.0.0.1:18830` (the engine runs, `/health` and `/api/health` with mode `server`, and `/api/sessions`), points `current` at it, and restarts the API |
| `autodeploy.sh` | Every 15 minutes, runs `deploy.sh` when main of any of the 10 repos moved |
| `run.sh` | Starts the API. It reads only `TRACES_SQL_PASSWORD` from `/Users/services/workspace/.env` |
| `ai.codecaine.observatory.plist` | The API LaunchAgent. `deploy.sh` installs it |
| `ai.codecaine.observatory.autodeploy.plist` | The poll LaunchAgent. You install it once by hand |

trace-viewer is private. The services user reads it with a read-only deploy key, `/Users/services/.ssh/deploy_trace-viewer`, through the SSH alias `github-trace-viewer`. The scripts point git at that alias for the trace-viewer remote.

## Deploy Now

Run the deploy as the services user from the running slot:

```sh
sudo -u services -H bash /Users/services/deploy/codecaine-core/current/observatory/deploy/services-01/deploy.sh
```

The script exits 75 when another deploy holds `/tmp/ai.codecaine.observatory.deploy.lock`.

## First Rollout of the Session Routes

The Session routes need the trace-viewer packages with `createSessionRoutes` and the sidebar shell. A slot builds trace-viewer from its main, so merge trace-viewer first and observatory after it. An observatory main with an older trace-viewer main fails the build of the idle slot, and the running slot stays.

Hold autodeploy for this first rollout, so the poll does not deploy a half-merged set:

1. Stop the poll: `sudo launchctl bootout gui/503/ai.codecaine.observatory.autodeploy`.
2. Merge trace-viewer, then observatory.
3. Run the deploy by hand (Deploy Now). Check `https://traces.lascari.dev/api/health` reports `"mode":"server"`, and the Work tab lists the Sessions.
4. Start the poll again: `sudo launchctl bootstrap gui/503 /Users/services/Library/LaunchAgents/ai.codecaine.observatory.autodeploy.plist`.

## Install

1. Run the first deploy as the services user with a copy of `deploy.sh`. It clones the 10 repos into slot `a` and loads `ai.codecaine.observatory`.
2. Copy `ai.codecaine.observatory.autodeploy.plist` to `/Users/services/Library/LaunchAgents/`, mode 644, owner services.
3. Load it in the services user's GUI session: `sudo launchctl bootstrap gui/503 /Users/services/Library/LaunchAgents/ai.codecaine.observatory.autodeploy.plist`.

The poll LaunchAgent runs `autodeploy.sh` under `fleet-run` from the fleet repo, at `/Users/services/.local/bin/fleet-run`. The fleet repo's `envsync/install.sh` installs it, so install it before step 2. After each run, `fleet-run` pushes the exit code to the Gatus row `jobs_observatory-autodeploy`, and a failed run posts to Slack.

## Clear a Stale Lock

A deploy killed with SIGKILL leaves `/tmp/ai.codecaine.observatory.deploy.lock`. Every later deploy then exits 75, and `autodeploy.log` reports the lock after an hour. Make sure no `deploy.sh` runs, then remove it:

```sh
sudo -u services rmdir /tmp/ai.codecaine.observatory.deploy.lock
```

## Retry a Failed Deploy

`autodeploy.log` names the failed set. Fix the cause on main, or delete the `failed` file to retry the same commits.
