#!/usr/bin/env bash
set -euo pipefail
umask 077

release_sha=${1:-}
repo=/opt/cloud-harness-mcp/repo
origin=https://github.com/bestagentkits/cloud-harness-mcp.git
state=/var/lib/cloud-harness
env_file=/etc/cloud-harness-mcp/runtime.env

if [[ ! $release_sha =~ ^[0-9a-f]{40}$ ]]; then
  echo "release must be an exact 40-character commit SHA" >&2
  exit 2
fi

if [[ ! -d $repo/.git ]]; then
  git clone --filter=blob:none --no-checkout "$origin" "$repo"
fi
cd "$repo"
[[ $(git remote get-url origin) == "$origin" ]] || { echo "unexpected deployment origin" >&2; exit 3; }
git fetch --force --prune origin main
git merge-base --is-ancestor "$release_sha" origin/main || { echo "release is not on origin/main" >&2; exit 4; }

previous_sha=$(cat "$state/release-current" 2>/dev/null || true)
backup=

wait_ready() {
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3100/readyz >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

record_images() {
  local prefix=$1
  docker image inspect cloud-harness-api:local --format '{{.Id}}' > "$state/${prefix}-api-image"
  docker image inspect cloud-harness-runner:local --format '{{.Id}}' > "$state/${prefix}-runner-image"
  docker image inspect cloud-harness-executor:local --format '{{.Id}}' > "$state/${prefix}-executor-image"
}

rollback() {
  local exit_code=$?
  local rollback_failed=0
  trap - ERR
  set +e
  if [[ -n $previous_sha && $previous_sha =~ ^[0-9a-f]{40}$ ]]; then
    git checkout --detach --force "$previous_sha" || rollback_failed=1
    if [[ -n $backup && -f $backup ]]; then cp --reflink=auto "$backup" "$state/state/cloud-harness.db" || rollback_failed=1; fi
    CLOUD_HARNESS_ENV_FILE="$env_file" HOST_JOBS_ROOT="$state/jobs" HOST_STATE_ROOT="$state/state" docker compose --profile images -f compose.yaml -f compose.production.yaml build executor-image api runner || rollback_failed=1
    systemctl start cloud-harness-mcp.service || rollback_failed=1
    wait_ready || rollback_failed=1
    if [[ $rollback_failed -eq 0 ]]; then
      record_images release || rollback_failed=1
      printf '%s\n' "$previous_sha" > "$state/release-current" || rollback_failed=1
    fi
  else
    systemctl disable --now cloud-harness-mcp.service || rollback_failed=1
    if [[ -L /etc/nginx/sites-enabled/cloud-harness-mcp.conf ]]; then
      rm -f /etc/nginx/sites-enabled/cloud-harness-mcp.conf || rollback_failed=1
      nginx -t && systemctl reload nginx || rollback_failed=1
    fi
  fi
  if [[ $rollback_failed -ne 0 ]]; then
    echo "deployment failed and rollback did not become healthy" >&2
    exit 70
  fi
  exit "$exit_code"
}
trap rollback ERR

systemctl stop cloud-harness-mcp.service
if [[ -f "$state/state/cloud-harness.db" ]]; then
  backup="$state/backups/cloud-harness-$(date -u +%Y%m%dT%H%M%SZ).db"
  cp --reflink=auto "$state/state/cloud-harness.db" "$backup"
fi

git checkout --detach --force "$release_sha"
[[ -z $(git status --porcelain --untracked-files=all) ]] || { echo "deployment checkout is dirty" >&2; false; }
CLOUD_HARNESS_ENV_FILE="$env_file" HOST_JOBS_ROOT="$state/jobs" HOST_STATE_ROOT="$state/state" docker compose --profile images -f compose.yaml -f compose.production.yaml build executor-image api runner
systemctl start cloud-harness-mcp.service
wait_ready

set +x
source "$env_file"
curl --fail --silent --show-error --max-time 10 --config - >/dev/null <<EOF
url = "http://127.0.0.1:3100/mcp"
request = "POST"
header = "Host: 127.0.0.1"
header = "Authorization: Bearer $MCP_BEARER_TOKEN"
header = "Content-Type: application/json"
header = "Accept: application/json, text/event-stream"
data = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-smoke","version":"1.0.0"}}}'
EOF

CLOUD_HARNESS_ENV_FILE="$env_file" HOST_JOBS_ROOT="$state/jobs" HOST_STATE_ROOT="$state/state" docker compose -f compose.yaml -f compose.production.yaml exec -T api node /app/scripts/deploy-canary.mjs
record_images release-new
mv "$state/release-new-api-image" "$state/release-api-image"
mv "$state/release-new-runner-image" "$state/release-runner-image"
mv "$state/release-new-executor-image" "$state/release-executor-image"
if [[ $previous_sha =~ ^[0-9a-f]{40}$ && $previous_sha != "$release_sha" ]]; then
  printf '%s\n' "$previous_sha" > "$state/release-previous"
fi
install -m 0755 deploy/scripts/deploy-release.sh /usr/local/sbin/cloud-harness-deploy
install -m 0755 deploy/scripts/rollback-release.sh /usr/local/sbin/cloud-harness-rollback
printf '%s\n' "$release_sha" > "$state/release-current"
trap - ERR
echo "deployed $release_sha"
