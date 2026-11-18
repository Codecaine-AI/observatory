# Observatory on services-01

Observatory runs in server mode (`OBSERVATORY_MODE=server`) on services-01 as the services user, on `127.0.0.1:8830`. Caddy serves `https://traces.lascari.dev` from it.

Server mode is read-only:
- It serves `/health`, the engine run routes, the Archon home's kernel routes, and an empty project list.
- It reads the runs from the trace ClickHouse, and it reads no registry.
- It mounts no launch, stop, logs, kernel proxy, or actions route, and it starts no liveness poll and no auto-launch.

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
| `deploy.sh` | Builds the idle slot, checks it on `127.0.0.1:18830`, points `current` at it, and restarts the API |
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

## Install

1. Run the first deploy as the services user with a copy of `deploy.sh`. It clones the 10 repos into slot `a` and loads `ai.codecaine.observatory`.
2. Copy `ai.codecaine.observatory.autodeploy.plist` to `/Users/services/Library/LaunchAgents/`, mode 644, owner services.
3. Load it in the services user's GUI session: `sudo launchctl bootstrap gui/503 /Users/services/Library/LaunchAgents/ai.codecaine.observatory.autodeploy.plist`.

## Clear a Stale Lock

A deploy killed with SIGKILL leaves `/tmp/ai.codecaine.observatory.deploy.lock`. Every later deploy then exits 75, and `autodeploy.log` reports the lock after an hour. Make sure no `deploy.sh` runs, then remove it:

```sh
sudo -u services rmdir /tmp/ai.codecaine.observatory.deploy.lock
```

## Retry a Failed Deploy

`autodeploy.log` names the failed set. Fix the cause on main, or delete the `failed` file to retry the same commits.
