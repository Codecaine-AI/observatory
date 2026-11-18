#!/usr/bin/env bash
# Deploys Observatory when main of any of its 10 repos moves. The ai.codecaine.observatory.autodeploy
# LaunchAgent runs this every 15 minutes as the services user.
#
# 1. Reads main of codecaine-core and of each member in members.json with git ls-remote.
# 2. Exits quietly when that set of commits is the deployed one (the deployed file).
# 3. Exits quietly when that set failed before (the failed file). Delete the file to retry it.
# 4. Exits quietly when another deploy holds /tmp/ai.codecaine.observatory.deploy.lock.
# 5. Runs deploy.sh from the running slot, pinned to that set. On a failure it writes the set to the failed file.
#
# State: /Users/services/.local/share/services-fleet/observatory/{deployed,failed}.
# With no running slot yet, run deploy.sh by hand once (README, Install).
set -euo pipefail

main() {
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export GIT_TERMINAL_PROMPT=0
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="url.git@github-trace-viewer:Codecaine-AI/trace-viewer.git.insteadOf"
  export GIT_CONFIG_VALUE_0="https://github.com/Codecaine-AI/trace-viewer.git"

  local root state_dir lock deploy target deployed failed
  root="${OBSERVATORY_DEPLOY_ROOT:-/Users/services/deploy/codecaine-core}"
  state_dir="${OBSERVATORY_DEPLOY_STATE_DIR:-/Users/services/.local/share/services-fleet/observatory}"
  lock=/tmp/ai.codecaine.observatory.deploy.lock
  deploy="$root/current/observatory/deploy/services-01/deploy.sh"
  mkdir -p "$state_dir"

  if [ ! -f "$deploy" ]; then
    log "error: $deploy is missing. Run the first deploy by hand (README, Install)."
    exit 1
  fi

  target="$(remote_heads "$root/current")" || { log "error: git ls-remote failed"; exit 1; }
  deployed="$(cat "$state_dir/deployed" 2>/dev/null || true)"
  failed="$(cat "$state_dir/failed" 2>/dev/null || true)"
  [ "$target" = "$deployed" ] && exit 0
  [ "$target" = "$failed" ] && exit 0
  if [ -d "$lock" ]; then
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
      log "waiting: $lock is over an hour old. If no deploy is running: rmdir $lock"
    fi
    exit 0
  fi

  log "main moved: $(changed "$deployed" "$target")"
  # deploy.sh deploys exactly these commits, so a failure below records the set that ran.
  printf '%s\n' "$target" >"$state_dir/pin"
  local status=0
  OBSERVATORY_DEPLOY_PIN="$state_dir/pin" bash "$deploy" || status=$?
  if [ "$status" = 0 ]; then
    rm -f "$state_dir/failed"
  elif [ "$status" = 75 ]; then
    log "skipped: another deploy started first. Trying again next round."
  else
    printf '%s\n' "$target" >"$state_dir/failed"
    log "error: the deploy failed (exit $status). Will not retry this set. To retry: rm $state_dir/failed"
    exit 1
  fi
}

# One "repo sha" line for codecaine-core and each member, sorted, as deploy.sh writes the deployed file.
remote_heads() {
  local slot="$1" dir remote sha
  {
    sha="$(git ls-remote https://github.com/Codecaine-AI/codecaine-core.git refs/heads/main | cut -f1)"
    [ -n "$sha" ] || return 1
    echo "codecaine-core $sha"
    while read -r dir remote; do
      sha="$(git ls-remote "$remote" refs/heads/main | cut -f1)"
      [ -n "$sha" ] || return 1
      echo "$dir $sha"
    done < <(/opt/homebrew/bin/bun -e 'for (const m of require(process.argv[1] + "/members.json")) console.log(m.dir + " " + m.remote)' "$slot")
  } | LC_ALL=C sort
}

# The repos whose commit differs between two sets, as "repo old..new".
changed() {
  LC_ALL=C join -a2 -e none -o 0,1.2,2.2 <(printf '%s\n' "$1") <(printf '%s\n' "$2") \
    | awk '$2 != $3 { printf "%s %s..%s ", $1, substr($2, 1, 7), substr($3, 1, 7) }'
}

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

main "$@"
