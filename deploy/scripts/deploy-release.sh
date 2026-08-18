#!/usr/bin/env bash
set -euo pipefail
umask 077

state=/var/lib/cloud-harness
install -d -o root -g root -m 0700 "$state"
deploy_lock="$state/deploy.lock"
exec 9>"$deploy_lock"
if ! flock -n 9; then
  echo "another Cloud Harness deployment is already running" >&2
  exit 75
fi

release_sha=${1:-}
repo=/opt/cloud-harness-mcp/repo
origin=https://github.com/bestagentkits/cloud-harness-mcp.git
install -d -m 0700 "$state/state" "$state/backups"
install -d -m 0750 "$state/jobs" "$state/artifacts"
env_file=/etc/cloud-harness-mcp/runtime.env

canary_credentials_file=/etc/cloud-harness-mcp/canary-credentials
config_root=/etc/cloud-harness-mcp

if grep -Eq '^(MCP_CANARY_URL|MCP_CANARY_ACCESS_CLIENT_ID|MCP_CANARY_ACCESS_CLIENT_SECRET)=' "$env_file"; then
  echo "Access canary credentials must be stored in $canary_credentials_file, not the runtime configuration" >&2
  exit 5
fi

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
source deploy/scripts/release-runtime.sh

previous_sha=$(cat "$state/release-current" 2>/dev/null || true)
backup_dir=
trap rollback ERR

stop_release
backup_dir="$state/backups/cloud-harness-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup_dir"
if [[ -f "$state/state/cloud-harness.db" ]]; then
  cp --reflink=auto "$state/state/cloud-harness.db" "$backup_dir/cloud-harness.db"
fi
tar -C "$state/artifacts" -cf "$backup_dir/artifacts.tar" .
if [[ $previous_sha =~ ^[0-9a-f]{40}$ ]]; then
  if [[ -d $state/release-config-current ]]; then
    cp -a "$state/release-config-current" "$backup_dir/config"
  elif [[ $previous_sha == "$release_sha" ]]; then
    cp -a "$config_root" "$backup_dir/config"
  else
    echo "last-known-good configuration is missing; redeploy the current release before promotion" >&2
    false
  fi
else
  cp -a "$config_root" "$backup_dir/config"
fi

git checkout --detach --force "$release_sha"
[[ -z $(git status --porcelain --untracked-files=all) ]] || { echo "deployment checkout is dirty" >&2; false; }
compose --profile images build executor-image api runner
systemctl enable --now cloud-harness-mcp.service
wait_ready
verify_running_images

set +x
source "$env_file"
auth_mode=${AUTH_MODE:-owner-bearer}
if [[ $auth_mode == owner-bearer ]]; then
  smoke_payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-smoke","version":"1.0.0"}}}'
  curl --fail --silent --show-error --max-time 10 --data-binary "$smoke_payload" --config - >/dev/null <<EOF
url = "http://127.0.0.1:3100/mcp"
request = "POST"
header = "Host: 127.0.0.1"
header = "Authorization: Bearer $MCP_BEARER_TOKEN"
header = "Content-Type: application/json"
header = "Accept: application/json, text/event-stream"
EOF
  compose exec -T api node /app/scripts/deploy-canary.mjs
elif [[ $auth_mode == cloudflare-access ]]; then
  deploy/scripts/upgrade-nginx-dashboard.sh
  [[ -f $canary_credentials_file ]] || { echo "$canary_credentials_file is required for Access canary" >&2; false; }
  set -a
  source "$canary_credentials_file"
  set +a
  [[ ${MCP_CANARY_URL:-} == https://* ]] || { echo "MCP_CANARY_URL must be the public HTTPS Access endpoint" >&2; false; }
  [[ -n ${MCP_CANARY_ACCESS_CLIENT_ID:-} ]] || { echo "MCP_CANARY_ACCESS_CLIENT_ID is required for Access canary" >&2; false; }
  [[ -n ${MCP_CANARY_ACCESS_CLIENT_SECRET:-} ]] || { echo "MCP_CANARY_ACCESS_CLIENT_SECRET is required for Access canary" >&2; false; }
  compose run --rm --no-deps \
      -e MCP_CANARY_URL -e MCP_CANARY_ACCESS_CLIENT_ID -e MCP_CANARY_ACCESS_CLIENT_SECRET \
      ingress node /app/scripts/deploy-canary.mjs
else
  echo "unsupported AUTH_MODE: $auth_mode" >&2
  false
fi
record_images release-new
mv "$state/release-new-api-image" "$state/release-api-image"
mv "$state/release-new-runner-image" "$state/release-runner-image"
mv "$state/release-new-executor-image" "$state/release-executor-image"
record_release_config
if [[ $previous_sha =~ ^[0-9a-f]{40}$ && $previous_sha != "$release_sha" ]]; then
  printf '%s\n' "$previous_sha" > "$state/release-previous"
fi
install -m 0755 deploy/scripts/deploy-release.sh /usr/local/sbin/cloud-harness-deploy
install -m 0755 deploy/scripts/rollback-release.sh /usr/local/sbin/cloud-harness-rollback
install -m 0755 deploy/scripts/upgrade-nginx-dashboard.sh /usr/local/sbin/cloud-harness-upgrade-nginx
printf '%s\n' "$release_sha" > "$state/release-current"
trap - ERR
echo "deployed $release_sha"
