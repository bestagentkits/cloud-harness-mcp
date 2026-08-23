#!/bin/bash
set -u

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
