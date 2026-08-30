#!/usr/bin/env bash

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

compose() {
  local compose_files=(-f compose.yaml -f compose.production.yaml)
  if [[ -f /etc/cloud-harness-mcp/ingress.conf ]]; then
    # shellcheck disable=SC1091
    source /etc/cloud-harness-mcp/ingress.conf 2>/dev/null || true
    if [[ ${INGRESS_MODE:-} == "tunnel" && -f deploy/cloudflare-tunnel/compose.tunnel.yaml ]]; then
      compose_files+=(-f deploy/cloudflare-tunnel/compose.tunnel.yaml)
      if [[ -f /etc/cloud-harness-mcp/tunnel.env ]]; then
        # shellcheck disable=SC1091
        source /etc/cloud-harness-mcp/tunnel.env 2>/dev/null || true
        export CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
      fi
    fi
  fi
  CLOUD_HARNESS_ENV_FILE="$env_file" HOST_JOBS_ROOT="$state/jobs" HOST_STATE_ROOT="$state/state" HOST_ARTIFACT_ROOT="$state/artifacts" \
    docker compose "${compose_files[@]}" "$@"
}

stop_release() {
  local failed=0 status containers
  systemctl stop cloud-harness-mcp.service || failed=1
  compose down --remove-orphans || failed=1
  if systemctl is-active --quiet cloud-harness-mcp.service; then
    failed=1
  else
    status=$?
    [[ $status -eq 3 ]] || failed=1
  fi
  if ! containers=$(compose ps -q); then
    failed=1
  elif [[ -n $containers ]]; then
    failed=1
  fi
  return "$failed"
}

contain_failed_release() {
  local failed=0 status containers
  systemctl disable --now cloud-harness-mcp.service || failed=1
  compose down --remove-orphans || failed=1
  if systemctl is-active --quiet cloud-harness-mcp.service; then
    failed=1
  else
    status=$?
    [[ $status -eq 3 ]] || failed=1
  fi
  if ! containers=$(compose ps -q); then
    failed=1
  elif [[ -n $containers ]]; then
    failed=1
  fi
  return "$failed"
}

verify_running_images() {
  local expected_api expected_runner service container actual
  expected_api=$(docker image inspect cloud-harness-api:local --format '{{.Id}}')
  expected_runner=$(docker image inspect cloud-harness-runner:local --format '{{.Id}}')
  for service in api ingress; do
    container=$(compose ps -q "$service")
    [[ -n $container ]] || return 1
    actual=$(docker inspect "$container" --format '{{.Image}}')
    [[ $actual == "$expected_api" ]] || return 1
  done
  container=$(compose ps -q runner)
  [[ -n $container ]] || return 1
  actual=$(docker inspect "$container" --format '{{.Image}}')
  [[ $actual == "$expected_runner" ]]
}

restore_snapshot() {
  local snapshot=$1
  [[ $snapshot == "$state/backups/"* && -d $snapshot ]] || return 1
  if [[ -f $snapshot/cloud-harness.db ]]; then
    cp --reflink=auto "$snapshot/cloud-harness.db" "$state/state/cloud-harness.db"
  fi
  if [[ -f $snapshot/artifacts.tar ]]; then
    [[ $state/artifacts == /var/lib/cloud-harness/artifacts ]] || return 1
    find "$state/artifacts" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    tar -C "$state/artifacts" -xf "$snapshot/artifacts.tar"
  fi
  restore_config_snapshot "$snapshot"
}

restore_config_snapshot() {
  local snapshot=$1
  local root=${config_root:-/etc/cloud-harness-mcp}
  local staged="${root}.rollback-restore.$$"
  local failed="${root}.failed-release.$$"
  [[ -d $snapshot/config && -d $root ]] || return 1
  [[ ! -e $staged && ! -e $failed ]] || return 1
  cp -a "$snapshot/config" "$staged" || return 1
  if ! mv "$root" "$failed"; then
    rm -rf -- "$staged"
    return 1
  fi
  if ! mv "$staged" "$root"; then
    mv "$failed" "$root" || true
    return 1
  fi
  rm -rf -- "$failed"
}

record_release_config() {
  local root=${config_root:-/etc/cloud-harness-mcp}
  local staged="$state/release-config-next"
  [[ -d $root ]] || return 1
  rm -rf -- "$staged"
  cp -a "$root" "$staged" || return 1
  rm -rf -- "$state/release-config-current"
  mv "$staged" "$state/release-config-current"
}

rollback() {
  local exit_code=$?
  local rollback_failed=0
  trap - ERR
  set +e
  stop_release || rollback_failed=1
  if [[ $rollback_failed -eq 0 && -n $previous_sha && $previous_sha =~ ^[0-9a-f]{40}$ ]]; then
    if ! git checkout --detach --force "$previous_sha"; then rollback_failed=1
    elif [[ -n $backup_dir ]] && ! restore_snapshot "$backup_dir"; then rollback_failed=1
    elif ! compose --profile images build executor-image api runner; then rollback_failed=1
    elif ! systemctl enable --now cloud-harness-mcp.service; then rollback_failed=1
    elif ! wait_ready; then rollback_failed=1
    elif ! verify_running_images; then rollback_failed=1
    elif ! record_release_config; then rollback_failed=1
    elif ! record_images release; then rollback_failed=1
    elif ! printf '%s\n' "$previous_sha" > "$state/release-current"; then rollback_failed=1
    fi
  elif [[ $rollback_failed -eq 0 ]]; then
    systemctl disable --now cloud-harness-mcp.service || rollback_failed=1
    if [[ -L /etc/nginx/sites-enabled/cloud-harness-mcp.conf ]]; then
      rm -f /etc/nginx/sites-enabled/cloud-harness-mcp.conf || rollback_failed=1
      nginx -t && systemctl reload nginx || rollback_failed=1
    fi
  fi
  if [[ $rollback_failed -ne 0 ]]; then
    contain_failed_release || true
    echo "deployment failed and rollback did not become healthy" >&2
    exit 70
  fi
  exit "$exit_code"
}
