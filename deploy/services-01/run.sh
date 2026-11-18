#!/bin/bash
# Starts the Observatory API in server mode for launchd (ai.codecaine.observatory).
# Installed with the deploy at /Users/services/deploy/codecaine-core/current/observatory/deploy/services-01/run.sh.
#
# launchd cannot read env files, so this wrapper reads the one secret the server needs,
# TRACES_SQL_PASSWORD, from the envsync file and exports only that line. The plist sets every
# other setting. deploy.sh also runs this script on a test port to check a new build.
set -euo pipefail

# The physical path: the slot that current names now. A later swap does not move this process.
app="$(cd "$(dirname "$0")/../.." && pwd -P)"
env_file="${OBSERVATORY_ENV_FILE:-/Users/services/workspace/.env}"
bun=/opt/homebrew/bin/bun

if [ ! -f "$env_file" ]; then
  echo "run.sh: $env_file is missing. envsync writes it from Infisical." >&2
  exit 1
fi
if [ -n "$(find "$env_file" -perm +077 2>/dev/null)" ]; then
  echo "run.sh: $env_file is readable by group or others. Run: chmod 600 $env_file" >&2
  exit 1
fi
: "${OBSERVATORY_MODE:?run.sh: OBSERVATORY_MODE must be set (the plist sets it)}"

value="$(sed -n 's/^TRACES_SQL_PASSWORD=//p' "$env_file" | tail -n 1)"
# A value may be quoted. Strip one pair of matching quotes.
case "$value" in
  \"*\") value="${value:1:${#value}-2}" ;;
  \'*\') value="${value:1:${#value}-2}" ;;
esac
export TRACES_SQL_PASSWORD="$value"
unset value

cd "$app"
exec "$bun" src/server/index.ts
