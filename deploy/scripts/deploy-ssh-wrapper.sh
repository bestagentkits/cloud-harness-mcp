#!/usr/bin/env bash
set -euo pipefail

original=${SSH_ORIGINAL_COMMAND:-}
if [[ $original =~ ^sudo\ -n\ /usr/local/sbin/cloud-harness-deploy\ \'([0-9a-f]{40})\'$ ]]; then
  exec sudo -n /usr/local/sbin/cloud-harness-deploy "${BASH_REMATCH[1]}"
fi

echo "deploy key is restricted to an exact cloud-harness release SHA" >&2
exit 126
