#!/bin/bash
set -u

task_id="$1"
timeout_seconds="$2"
task_dir=/tmp/cloud-harness-tasks
pid_file="$task_dir/$task_id.pid"
child_pid=''

cleanup() {
  rm -f -- "$pid_file"
}

terminate() {
  if [[ -n "$child_pid" ]]; then
    kill -TERM -- "-$child_pid" 2>/dev/null || true
  fi
  cleanup
}

trap 'terminate; exit 143' TERM INT
trap cleanup EXIT

mkdir -p -- "$task_dir"
/usr/bin/setsid /usr/bin/timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" \
  /bin/bash -lc 'exec /bin/bash -lc "$CH_COMMAND"' &
child_pid=$!
printf '%s\n' "$child_pid" > "$pid_file"
wait "$child_pid"
