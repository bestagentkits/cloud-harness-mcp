#!/usr/bin/env bash
set -euo pipefail

repo=/opt/cloud-harness-mcp/repo
state=/var/lib/cloud-harness
previous=$(cat "$state/release-previous" 2>/dev/null || true)
[[ $previous =~ ^[0-9a-f]{40}$ ]] || { echo "no recorded previous release available" >&2; exit 1; }
git -C "$repo" merge-base --is-ancestor "$previous" origin/main || { echo "recorded previous release is not on origin/main" >&2; exit 1; }
exec /usr/local/sbin/cloud-harness-deploy "$previous"
