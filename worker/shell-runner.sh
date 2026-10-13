#!/bin/bash
set -u
export PATH="/workspace/node_modules/.bin:/opt/user-tools/bin:/opt/user-tools/pnpm/bin:/opt/user-tools/pnpm:/opt/user-tools/bun/bin:/tmp/cloud-harness-home/.local/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

shell_id="$1"
shell_dir=/tmp/cloud-harness-shells
pid_file="$shell_dir/$shell_id.pid"

mkdir -p -- "$shell_dir" /tmp/cloud-harness-home
printf '%s\n' "$$" > "$pid_file"
exec /bin/bash --noprofile --norc
