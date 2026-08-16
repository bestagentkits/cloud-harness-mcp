#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "bootstrap-vps.sh must run as root" >&2
  exit 1
fi

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
install -d -m 0755 /opt/cloud-harness-mcp
install -d -m 0700 /etc/cloud-harness-mcp /var/lib/cloud-harness/state /var/lib/cloud-harness/backups
install -d -m 0750 /var/lib/cloud-harness/jobs

if [[ ! -f /etc/cloud-harness-mcp/runtime.env ]]; then
  mcp_token=$(openssl rand -base64 48 | tr -d '\n')
  runner_token=$(openssl rand -base64 48 | tr -d '\n')
  install -m 0600 /dev/null /etc/cloud-harness-mcp/runtime.env
  {
    printf 'MCP_BEARER_TOKEN=%s\n' "$mcp_token"
    printf 'RUNNER_TOKEN=%s\n' "$runner_token"
    printf '%s\n' 'OWNER_ID=owner'
    printf '%s\n' 'API_PUBLIC_HOSTS=127.0.0.1,localhost,cloud-harness-mcp.46-250-239-227.sslip.io'
    printf '%s\n' 'API_ALLOWED_ORIGINS=https://cloud-harness-mcp.46-250-239-227.sslip.io'
    printf '%s\n' 'API_PORT=3000' 'RUNNER_PORT=3001' 'RUNNER_URL=http://runner:3001'
    printf '%s\n' 'JOBS_ROOT=/var/lib/cloud-harness/jobs' 'STATE_DB=/var/lib/cloud-harness/state/cloud-harness.db'
    printf '%s\n' 'EXECUTOR_IMAGE=cloud-harness-executor:local' 'ALLOWED_GIT_HOSTS=github.com' 'WORKSPACE_NETWORK_MODE=none'
    printf '%s\n' 'WORKSPACE_WALL_TTL_SECONDS=900' 'WORKSPACE_IDLE_TTL_SECONDS=300'
  } > /etc/cloud-harness-mcp/runtime.env
fi

install -m 0755 "$project_root/deploy/scripts/deploy-release.sh" /usr/local/sbin/cloud-harness-deploy
install -m 0755 "$project_root/deploy/scripts/rollback-release.sh" /usr/local/sbin/cloud-harness-rollback
install -m 0755 "$project_root/deploy/scripts/deploy-ssh-wrapper.sh" /usr/local/sbin/cloud-harness-deploy-ssh
install -m 0644 "$project_root/deploy/systemd/cloud-harness-mcp.service" /etc/systemd/system/cloud-harness-mcp.service
install -m 0644 "$project_root/deploy/nginx/cloud-harness-mcp.conf" /etc/nginx/sites-available/cloud-harness-mcp.conf
ln -sfn /etc/nginx/sites-available/cloud-harness-mcp.conf /etc/nginx/sites-enabled/cloud-harness-mcp.conf

cat > /etc/sudoers.d/cloud-harness-mcp-deploy <<'EOF'
dev ALL=(root) NOPASSWD: /usr/local/sbin/cloud-harness-deploy [0-9a-f]*, /usr/local/sbin/cloud-harness-rollback
EOF
chmod 0440 /etc/sudoers.d/cloud-harness-mcp-deploy
visudo -cf /etc/sudoers.d/cloud-harness-mcp-deploy
systemctl daemon-reload
systemctl enable cloud-harness-mcp.service
nginx -t
systemctl reload nginx
