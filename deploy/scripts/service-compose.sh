#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR=/etc/cloud-harness-mcp
STATE_DIR=/var/lib/cloud-harness
ENV_FILE="${CLOUD_HARNESS_ENV_FILE:-$CONFIG_DIR/runtime.env}"

compose_files=("-f" "compose.yaml" "-f" "compose.production.yaml")

if [[ -f "$CONFIG_DIR/ingress.conf" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_DIR/ingress.conf"
  if [[ "${INGRESS_MODE:-}" == "tunnel" && -f "deploy/cloudflare-tunnel/compose.tunnel.yaml" ]]; then
    compose_files+=("-f" "deploy/cloudflare-tunnel/compose.tunnel.yaml")
    if [[ -f "$CONFIG_DIR/tunnel.env" ]]; then
      # shellcheck disable=SC1090
      source "$CONFIG_DIR/tunnel.env"
      export CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
    fi
  fi
fi

export CLOUD_HARNESS_ENV_FILE="$ENV_FILE"
export HOST_JOBS_ROOT="${HOST_JOBS_ROOT:-$STATE_DIR/jobs}"
export HOST_STATE_ROOT="${HOST_STATE_ROOT:-$STATE_DIR/state}"
export HOST_ARTIFACT_ROOT="${HOST_ARTIFACT_ROOT:-$STATE_DIR/artifacts}"

exec /usr/bin/docker compose "${compose_files[@]}" "$@"
