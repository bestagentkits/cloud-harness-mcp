#!/bin/bash
set -u

shell_id="$1"
shell_dir=/tmp/cloud-harness-shells
pid_file="$shell_dir/$shell_id.pid"

mkdir -p -- "$shell_dir"
printf '%s\n' "$$" > "$pid_file"
exec /bin/bash --noprofile --norc
