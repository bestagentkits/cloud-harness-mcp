#!/bin/bash
set -u
export PATH="/workspace/node_modules/.bin:/opt/user-tools/bin:/opt/user-tools/pnpm/bin:/opt/user-tools/pnpm:/opt/user-tools/bun/bin:/tmp/cloud-harness-home/.local/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

operation_id="$1"
operation_dir=/tmp/cloud-harness-operations
pid_file="$operation_dir/$operation_id.pid"

cleanup() {
  rm -f -- "$pid_file"
}

trap cleanup EXIT
mkdir -p -- "$operation_dir" /tmp/cloud-harness-home
printf '%s\n' "$$" > "$pid_file"
export CH_OPERATION_PID_FILE="$pid_file"
node /opt/harness/harness-worker.mjs
