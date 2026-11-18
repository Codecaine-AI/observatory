#!/usr/bin/env bash
# Deploys Observatory in server mode on services-01, from main of codecaine-core and its 9 members.
# Runs as the services user, by hand or from autodeploy.sh. It needs no sudo.
#
# Two full checkouts, slots a and b, live in /Users/services/deploy/codecaine-core. The link
# `current` names the slot that runs. A deploy only ever changes the other slot:
#
# 1. Takes the lock /tmp/ai.codecaine.observatory.deploy.lock. Exits 75 when another deploy holds it.
# 2. Clones or fetches the 10 repos into the idle slot, and resets each one to origin/main.
# 3. Links .bun-links, runs bun install --frozen-lockfile at the root and in observatory, and builds the UI.
# 4. Starts the new slot on 127.0.0.1:18830 and checks that it answers. Stops it again.
# 5. Points `current` at the new slot in one rename, and restarts ai.codecaine.observatory.
# 6. Checks 127.0.0.1:8830. On a failure it points `current` back and restarts the old slot.
# 7. Logs the commit of each repo and writes them to the deployed file.
#
# A failure before step 5 leaves the running slot, the link, and the service untouched.
#
# Usage: deploy.sh
# Log: each line also goes to /Users/services/Library/Logs/services-fleet/observatory/deploy.log.
# OBSERVATORY_DEPLOY_PIN: a file of "repo sha" lines. Each repo it names deploys that commit, not the head of
# its branch. autodeploy.sh pins the set it polled, so the set it records is the set that deployed.
# Overrides (for testing): OBSERVATORY_DEPLOY_ROOT, OBSERVATORY_DEPLOY_STATE_DIR, and
# OBSERVATORY_DEPLOY_BRANCH, the observatory branch to deploy (default main). Point a test at its own root:
# the swap and the restart of step 5 always act on the ai.codecaine.observatory agent.
set -euo pipefail

# Everything runs inside main, so bash has read the whole file before a git reset can change it.
main() {
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export GIT_PAGER=cat GIT_TERMINAL_PROMPT=0
  # trace-viewer is private. Its read-only deploy key answers on the github-trace-viewer SSH alias.
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="url.git@github-trace-viewer:Codecaine-AI/trace-viewer.git.insteadOf"
  export GIT_CONFIG_VALUE_0="https://github.com/Codecaine-AI/trace-viewer.git"

  if [ "$(id -un)" != services ]; then
    echo "error: run deploy.sh as the services user: sudo -u services -H $0" >&2
    exit 2
  fi

  local root state_dir lock bun label uid agents_dir plist_dst
  root="${OBSERVATORY_DEPLOY_ROOT:-/Users/services/deploy/codecaine-core}"
  state_dir="${OBSERVATORY_DEPLOY_STATE_DIR:-/Users/services/.local/share/services-fleet/observatory}"
  lock=/tmp/ai.codecaine.observatory.deploy.lock
  bun=/opt/homebrew/bin/bun
  label=ai.codecaine.observatory
  uid="$(id -u)"
  agents_dir=/Users/services/Library/LaunchAgents

  mkdir -p "$root" "$state_dir" /Users/services/Library/Logs/services-fleet/observatory
  if ! mkdir "$lock" 2>/dev/null; then
    log "busy: another deploy holds $lock. If none is running: rmdir $lock"
    exit 75
  fi
  # The trap runs after main returns, when its locals are gone, so it gets the path now.
  # shellcheck disable=SC2064
  trap "rmdir '$lock' 2>/dev/null || true" EXIT

  local running="" next
  [ -L "$root/current" ] && running="$(basename "$(readlink "$root/current")")"
  next=a
  [ "$running" = a ] && next=b
  local slot="$root/$next"
  log "deploy into slot $next (running: ${running:-none})"

  local pin="${OBSERVATORY_DEPLOY_PIN:-}"
  [ -z "$pin" ] || [ -f "$pin" ] || fail "OBSERVATORY_DEPLOY_PIN names no file: $pin"
  sync_repo "$slot" https://github.com/Codecaine-AI/codecaine-core.git main "$(pinned codecaine-core)"
  local dir remote branch
  while read -r dir remote; do
    branch=main
    [ "$dir" = observatory ] && branch="${OBSERVATORY_DEPLOY_BRANCH:-main}"
    sync_repo "$slot/$dir" "$remote" "$branch" "$(pinned "$dir")"
  done < <(members "$slot")

  link_bun_links "$slot/observatory"

  log "install"
  (cd "$slot" && "$bun" install --frozen-lockfile)
  (cd "$slot/observatory" && "$bun" install --frozen-lockfile)
  log "build"
  (cd "$slot/observatory" && "$bun" run build)
  [ -f "$slot/observatory/src/ui/dist/index.html" ] || fail "the build made no src/ui/dist/index.html"
  for dir in . $(members "$slot" | cut -d' ' -f1); do
    # bun install makes package bin files executable. A mode change is not drift.
    if [ -n "$(git -c core.fileMode=false -C "$slot/$dir" status --porcelain)" ]; then
      git -c core.fileMode=false -C "$slot/$dir" status --short >&2
      fail "install or build changed tracked files in $dir (lockfile drift?)"
    fi
  done

  check_slot "$slot"

  plist_dst="$agents_dir/$label.plist"
  plutil -lint -s "$slot/observatory/deploy/services-01/$label.plist" || fail "the new slot's plist is not valid"

  # One rename(2) swaps the link, so `current` always names a whole slot.
  point_current "$next"
  log "current -> $next"
  # From here on, every failure goes back to the running slot. activate never exits the script.
  if ! activate "$slot" || ! wait_answers 8830 60; then
    if [ -z "$running" ]; then
      fail "127.0.0.1:8830 did not answer on slot $next"
    fi
    point_current "$running"
    if activate "$root/$running" && wait_answers 8830 60; then
      fail "127.0.0.1:8830 did not answer on slot $next. current -> $running again, and it answers"
    fi
    fail "127.0.0.1:8830 did not answer on slot $next, and slot $running did not come back. Logs: /Users/services/Library/Logs/services-fleet/observatory/"
  fi

  local deployed="$state_dir/deployed" line
  : >"$deployed.next"
  for dir in . $(members "$slot" | cut -d' ' -f1); do
    line="$(repo_name "$dir") $(git -C "$slot/$dir" rev-parse HEAD)"
    printf '%s\n' "$line" >>"$deployed.next"
    log "deployed $(repo_name "$dir") $(git -C "$slot/$dir" log -1 --format='%h %s')"
  done
  LC_ALL=C sort -o "$deployed.next" "$deployed.next"
  mv -f "$deployed.next" "$deployed"
  log "done: slot $next serves 127.0.0.1:8830"
}

# Points the current link at a slot in one rename.
point_current() {
  ln -sfn "$1" "$root/current.next"
  mv -fh "$root/current.next" "$root/current"
}

# Installs the slot's plist when it changed, and (re)starts the agent on the slot that current names.
# Returns 1 on any launchctl error, and never exits, so the caller can roll back.
activate() {
  local src="$1/observatory/deploy/services-01/$label.plist"
  if ! cmp -s "$src" "$plist_dst" 2>/dev/null; then
    install -m 0644 "$src" "$plist_dst" || return 1
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true
    wait_unloaded "gui/$uid/$label" || return 1
  fi
  if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$uid/$label" || return 1
  else
    launchctl bootstrap "gui/$uid" "$plist_dst" || return 1
  fi
}

# The pinned commit of a repo, or nothing when no pin names it.
pinned() {
  [ -n "$pin" ] || return 0
  awk -v repo="$1" '$1 == repo { print $2 }' "$pin"
}

# Clones a repo, or fetches it, and resets it to the pinned commit, or else to origin/<branch>.
# Ignored files (node_modules) stay.
sync_repo() {
  local dir="$1" remote="$2" branch="$3" sha="${4:-}"
  if [ ! -d "$dir/.git" ]; then
    # A partial clone fetches only the files a checkout needs. docs-system has a large history.
    git clone --quiet --filter=blob:none "$remote" "$dir"
  else
    git -C "$dir" remote set-url origin "$remote"
  fi
  git -C "$dir" fetch --quiet --prune origin "$branch"
  if [ -n "$sha" ]; then
    git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null || fail "$dir has no commit $sha on origin/$branch"
    git -C "$dir" checkout --quiet --force -B "$branch" "$sha"
  else
    git -C "$dir" checkout --quiet --force -B "$branch" "origin/$branch"
  fi
  git -C "$dir" clean -ffdq
}

# The members of codecaine-core: one "dir remote" line each, from the slot's members.json.
members() {
  "$bun" -e 'for (const m of require(process.argv[1] + "/members.json")) console.log(m.dir + " " + m.remote)' "$1"
}

# The repo name of a slot folder: codecaine-core for the slot root, else the member folder.
repo_name() {
  if [ "$1" = . ]; then echo codecaine-core; else echo "$1"; fi
}

# The link: dependencies of observatory resolve through .bun-links (README, Run).
link_bun_links() {
  local links="$1/.bun-links/node_modules/@codecaine-ai" name target
  mkdir -p "$links"
  while read -r name target; do
    ln -sfn "../../../../$target" "$links/$name"
  done <<'LINKS'
action-log annotations/packages/action-log
design-system design-system
agent-kernel agent-kernel/packages/kernel
agent-kernel-db agent-kernel/packages/db
agent-kernel-protocol agent-kernel/packages/protocol
agent-kernel-viewer-core trace-viewer/packages/viewer-core
agent-kernel-viewer-ui trace-viewer/packages/viewer-ui
agent-kernel-viewer-shell trace-viewer/packages/viewer-shell
agent-kernel-viewer-read-service trace-viewer/packages/read-service
prompt-kit prompt-kit/packages/prompt-kit
LINKS
}

# Starts the slot's server on 127.0.0.1:18830 with the plist settings, and checks it answers.
check_slot() {
  local slot="$1" pid
  log "check slot on 127.0.0.1:18830"
  OBSERVATORY_MODE=server OBSERVATORY_API_PORT=18830 OBSERVATORY_ARCHON_HOME=/Users/services/.archon \
    TRACES_SQL_URL=http://127.0.0.1:8123/ TRACES_SQL_USER=traces_ro \
    bash "$slot/observatory/deploy/services-01/run.sh" >/tmp/ai.codecaine.observatory.check.log 2>&1 &
  pid=$!
  if ! wait_answers 18830 30; then
    kill "$pid" 2>/dev/null || true
    tail -n 20 /tmp/ai.codecaine.observatory.check.log >&2 || true
    fail "the new slot did not answer on 127.0.0.1:18830"
  fi
  if ! curl -fsS --max-time 30 -o /dev/null http://127.0.0.1:18830/api/engine-runs; then
    kill "$pid" 2>/dev/null || true
    fail "the new slot did not list the engine runs"
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# Waits up to $2 s for GET /registry/projects on a loopback port to answer 200.
wait_answers() {
  local port="$1" seconds="$2"
  for _ in $(seq 1 "$seconds"); do
    curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/registry/projects" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

wait_unloaded() {
  for _ in $(seq 1 20); do
    launchctl print "$1" >/dev/null 2>&1 || return 0
    sleep 1
  done
  log "error: $1 did not unload within 20 s"
  return 1
}

fail() {
  log "error: $*"
  exit 1
}

log() {
  local line
  line="$(date '+%Y-%m-%dT%H:%M:%S%z') $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>/Users/services/Library/Logs/services-fleet/observatory/deploy.log
}

main "$@"
