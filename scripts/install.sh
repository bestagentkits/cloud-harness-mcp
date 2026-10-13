#!/usr/bin/env bash
# CloudHarness MCP 1-Click Installer
# https://github.com/bestagentkits/cloud-harness-mcp
set -euo pipefail
umask 077

PROJECT_ORIGIN="https://github.com/bestagentkits/cloud-harness-mcp.git"
INSTALL_ROOT="/opt/cloud-harness-mcp"
REPO_DIR="$INSTALL_ROOT/repo"
CONFIG_DIR="/etc/cloud-harness-mcp"
STATE_DIR="/var/lib/cloud-harness"

DOMAIN=""
EMAIL=""
INGRESS_MODE="caddy"
TUNNEL_TOKEN=""
NON_INTERACTIVE=false
RELEASE_SHA=""

log() {
  printf '[cloud-harness-installer] %s\n' "$*"
}

error() {
  printf '[cloud-harness-installer ERROR] %s\n' "$*" >&2
}

require_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    error "install.sh must run as root. Please run: sudo bash install.sh (or curl -fsSL ... | sudo bash)"
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)
        DOMAIN="$2"
        shift 2
        ;;
      --email)
        EMAIL="$2"
        shift 2
        ;;
      --ingress)
        case "$2" in
          caddy|tunnel|custom)
            INGRESS_MODE="$2"
            ;;
          *)
            error "Invalid ingress mode: $2. Must be one of: caddy, tunnel, custom."
            exit 1
            ;;
        esac
        shift 2
        ;;
      --tunnel-token)
        TUNNEL_TOKEN="$2"
        shift 2
        ;;
      --release-sha)
        RELEASE_SHA="$2"
        shift 2
        ;;
      --non-interactive)
        NON_INTERACTIVE=true
        shift
        ;;
      --help|-h)
        cat <<'EOF'
CloudHarness MCP 1-Click Installer

Options:
  --domain <DOMAIN>          Public domain for HTTPS TLS termination (e.g. mcp.example.com)
  --email <EMAIL>            Email address for Let's Encrypt TLS certificate notifications
  --ingress <caddy|tunnel|custom>
                             Ingress type (default: caddy)
  --tunnel-token <TOKEN>     Cloudflare Tunnel token (required if --ingress tunnel)
  --release-sha <SHA>        Pinned 40-character Git commit SHA to deploy
  --non-interactive          Run without interactive prompts
  --help, -h                 Show this help message
EOF
        exit 0
        ;;
      *)
        error "Unknown argument: $1"
        exit 1
        ;;
    esac
  done
}

preflight_checks() {
  log "Running preflight system verification..."

  # OS detection
  if [[ ! -f /etc/os-release ]]; then
    error "Cannot detect operating system (/etc/os-release missing)."
    exit 1
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  OS_ID=${ID:-linux}
  log "Detected OS: $OS_ID ($VERSION_ID)"

  case "$OS_ID" in
    ubuntu|debian|rocky|rhel|almalinux|fedora)
      log "Supported OS family: $OS_ID"
      ;;
    *)
      log "Warning: Unrecognized OS $OS_ID. Proceeding under standard Linux conventions."
      ;;
  esac

  # Architecture
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64|aarch64|arm64)
      log "Supported architecture: $ARCH"
      ;;
    *)
      error "Unsupported architecture: $ARCH. CloudHarness requires x86_64 or aarch64."
      exit 1
      ;;
  esac

  # Memory check (>= 2GB total)
  TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  TOTAL_MEM_MB=$((TOTAL_MEM_KB / 1024))
  if [[ $TOTAL_MEM_MB -lt 1800 ]]; then
    error "Insufficient RAM: ${TOTAL_MEM_MB}MB detected. Minimum 2048MB required."
    exit 1
  fi
  log "RAM check passed: ${TOTAL_MEM_MB}MB available."

  # Storage check (>= 10GB free under /var/lib)
  AVAILABLE_DISK_KB=$(df -Pk /var/lib 2>/dev/null | tail -1 | awk '{print $4}')
  AVAILABLE_DISK_GB=$((AVAILABLE_DISK_KB / 1024 / 1024))
  if [[ $AVAILABLE_DISK_GB -lt 10 ]]; then
    error "Insufficient disk space: ${AVAILABLE_DISK_GB}GB free in /var/lib. Minimum 10GB required for containers, builds, and artifacts."
    exit 1
  fi
  log "Disk check passed: ${AVAILABLE_DISK_GB}GB free."

  # Port check for Caddy
  if [[ "$INGRESS_MODE" == "caddy" ]]; then
    if command -v ss >/dev/null 2>&1; then
      if ss -ltn 'sport = :80 or sport = :443' | grep -Eq ':(80|443)\b'; then
        error "Port 80 or 443 is already bound by another process. For direct Caddy TLS, ports 80 and 443 must be free. Alternatively, use '--ingress tunnel' (Cloudflare Tunnel) or '--ingress custom' (existing reverse proxy)."
        exit 1
      fi
    fi
  fi
}

read_prompt() {
  local prompt_msg=$1
  local target_var=$2
  local is_secret=${3:-false}
  local input_val=""

  if [[ -c /dev/tty ]]; then
    if [[ "$is_secret" == "true" ]]; then
      read -r -s -p "$prompt_msg" input_val < /dev/tty || true
      echo "" > /dev/tty || true
    else
      read -r -p "$prompt_msg" input_val < /dev/tty || true
    fi
  elif [[ -t 0 ]]; then
    if [[ "$is_secret" == "true" ]]; then
      read -r -s -p "$prompt_msg" input_val || true
      echo ""
    else
      read -r -p "$prompt_msg" input_val || true
    fi
  fi
  printf -v "$target_var" '%s' "$input_val"
}

resolve_ingress_inputs() {
  if [[ -z "$DOMAIN" && "$NON_INTERACTIVE" == "false" ]]; then
    read_prompt "Enter public domain / hostname for MCP server (e.g. mcp.example.com, or press enter for localhost): " DOMAIN false
  fi

  if [[ "$INGRESS_MODE" == "caddy" && -n "$DOMAIN" && -z "$EMAIL" && "$NON_INTERACTIVE" == "false" ]]; then
    read_prompt "Enter email for Let's Encrypt TLS certificate expiry notices (optional): " EMAIL false
  fi

  if [[ "$INGRESS_MODE" == "tunnel" ]]; then
    if [[ -z "$DOMAIN" ]]; then
      error "Cloudflare Tunnel mode requires a public domain / hostname for API_PUBLIC_HOSTS validation. Please provide --domain <DOMAIN>."
      exit 1
    fi
    if [[ -z "$TUNNEL_TOKEN" && "$NON_INTERACTIVE" == "false" ]]; then
      read_prompt "Enter Cloudflare Tunnel Token: " TUNNEL_TOKEN true
    fi
    if [[ -z "$TUNNEL_TOKEN" ]]; then
      error "Cloudflare Tunnel mode requires a valid tunnel token. Please provide --tunnel-token <TOKEN> or enter it when prompted."
      exit 1
    fi
  fi
}

install_dependencies() {
  log "Installing base utility dependencies (git, openssl, tar, curl, certificates)..."
  case "$OS_ID" in
    ubuntu|debian)
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg lsb-release git openssl tar
      ;;
    rocky|rhel|almalinux|fedora)
      dnf install -y git openssl tar curl gnupg2 ca-certificates dnf-plugins-core
      ;;
  esac

  log "Checking Docker and container dependencies..."
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    log "Installing Docker CE and Docker Compose plugin..."
    case "$OS_ID" in
      ubuntu|debian)
        install -m 0755 -d /etc/apt/keyrings
        if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
          curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
          chmod a+r /etc/apt/keyrings/docker.gpg
        fi
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_ID $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
        apt-get update -y
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        systemctl enable --now docker
        ;;
      rocky|rhel|almalinux|fedora)
        dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        systemctl enable --now docker
        ;;
      *)
        error "Automated Docker installation is not supported for $OS_ID. Please install Docker CE and Docker Compose manually."
        exit 1
        ;;
    esac
  fi

  if [[ "$INGRESS_MODE" == "caddy" ]]; then
    if ! command -v caddy >/dev/null 2>&1; then
      log "Installing Caddy web server for automated Let's Encrypt TLS..."
      case "$OS_ID" in
        ubuntu|debian)
          apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
          curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
          curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
          apt-get update -y
          apt-get install -y caddy
          ;;
        rocky|rhel|almalinux|fedora)
          dnf install -y 'dnf-command(copr)'
          dnf copr enable -y @caddy/caddy
          dnf install -y caddy
          ;;
      esac
    fi
  fi
}

bootstrap_directories() {
  log "Bootstrapping directory hierarchy with strict permissions..."
  install -d -m 0755 "$INSTALL_ROOT"
  install -d -m 0700 "$CONFIG_DIR"
  install -d -m 0700 "$STATE_DIR" "$STATE_DIR/state" "$STATE_DIR/backups"
  install -d -m 0750 "$STATE_DIR/jobs" "$STATE_DIR/artifacts" "$STATE_DIR/cache/repos"
}

checkout_repository() {
  log "Cloning and verifying repository..."
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    git clone --filter=blob:none "$PROJECT_ORIGIN" "$REPO_DIR"
  fi

  cd "$REPO_DIR"
  git fetch --prune origin main

  if [[ -z "$RELEASE_SHA" ]]; then
    RELEASE_SHA=$(git rev-parse origin/main)
    log "Target release SHA resolved: $RELEASE_SHA"
  fi
}

bootstrap_secrets() {
  log "Configuring cryptographic secrets and runtime environment..."
  local env_file="$CONFIG_DIR/runtime.env"
  local keyring_file="$CONFIG_DIR/secret-keyring.json"

  # Idempotent Secret Keyring Generation
  if [[ ! -f "$keyring_file" ]]; then
    log "Generating secret keyring at $keyring_file..."
    local key_b64
    key_b64=$(openssl rand -base64 32 | tr -d '\n')
    printf '{"activeVersion":1,"keys":[{"version":1,"key":"%s"}]}\n' "$key_b64" > "$keyring_file"
    chmod 0600 "$keyring_file"
  else
    log "Preserving existing secret keyring at $keyring_file."
  fi

  # Idempotent Runtime Environment Generation
  if [[ ! -f "$env_file" ]]; then
    log "Generating runtime environment at $env_file..."
    local mcp_bearer_token runner_token
    mcp_bearer_token=$(openssl rand -base64 48 | tr -d '\n')
    runner_token=$(openssl rand -base64 48 | tr -d '\n')

    local public_hosts="127.0.0.1,localhost"
    local allowed_origins="http://127.0.0.1:3100"
    if [[ -n "$DOMAIN" ]]; then
      public_hosts="$public_hosts,$DOMAIN"
      allowed_origins="https://$DOMAIN"
    fi

    install -m 0600 /dev/null "$env_file"
    {
      printf 'AUTH_MODE=owner-bearer\n'
      printf 'OWNER_ID=owner\n'
      printf 'MCP_BEARER_TOKEN=%s\n' "$mcp_bearer_token"
      printf 'RUNNER_TOKEN=%s\n' "$runner_token"
      printf 'SECRET_KEYRING_FILE=/run/cloud-harness-secrets/secret-keyring.json\n'
      printf 'API_PUBLIC_HOSTS=%s\n' "$public_hosts"
      printf 'API_ALLOWED_ORIGINS=%s\n' "$allowed_origins"
      printf 'API_PORT=3000\n'
      printf 'RUNNER_PORT=3001\n'
      printf 'RUNNER_URL=http://runner:3001\n'
      printf 'JOBS_ROOT=/var/lib/cloud-harness/jobs\n'
      printf 'STATE_DB=/var/lib/cloud-harness/state/cloud-harness.db\n'
      printf 'ARTIFACT_ROOT=/var/lib/cloud-harness/artifacts\n'
      printf 'REPO_CACHE_ROOT=/var/lib/cloud-harness/cache/repos\n'
      printf 'EXECUTOR_IMAGE=cloud-harness-executor:local\n'
      printf 'ALLOWED_GIT_HOSTS=github.com\n'
      printf 'WORKSPACE_NETWORK_MODE=none\n'
      printf 'WORKSPACE_WALL_TTL_SECONDS=900\n'
      printf 'WORKSPACE_IDLE_TTL_SECONDS=300\n'
    } > "$env_file"
    chmod 0600 "$env_file"
  else
    log "Preserving existing runtime configuration at $env_file."
    if [[ -n "$DOMAIN" ]]; then
      local current_hosts current_origins
      current_hosts=$(grep '^API_PUBLIC_HOSTS=' "$env_file" | cut -d'=' -f2- || true)
      current_origins=$(grep '^API_ALLOWED_ORIGINS=' "$env_file" | cut -d'=' -f2- || true)
      if [[ -n "$current_hosts" && ! "$current_hosts" =~ (^|,)$DOMAIN(,|$) ]]; then
        sed -i -e "s|^API_PUBLIC_HOSTS=.*|API_PUBLIC_HOSTS=$current_hosts,$DOMAIN|" "$env_file"
        log "Reconciled API_PUBLIC_HOSTS with domain $DOMAIN"
      fi
      if [[ -n "$current_origins" && ! "$current_origins" =~ https://$DOMAIN ]]; then
        sed -i -e "s|^API_ALLOWED_ORIGINS=.*|API_ALLOWED_ORIGINS=$current_origins,https://$DOMAIN|" "$env_file"
        log "Reconciled API_ALLOWED_ORIGINS with domain https://$DOMAIN"
      fi
    fi
  fi
}

configure_ingress() {
  log "Configuring ingress topology: $INGRESS_MODE..."
  printf 'INGRESS_MODE=%s\n' "$INGRESS_MODE" > "$CONFIG_DIR/ingress.conf"
  chmod 0600 "$CONFIG_DIR/ingress.conf"

  if [[ "$INGRESS_MODE" == "caddy" ]]; then

    if [[ -n "$DOMAIN" ]]; then
      local tls_config=""
      if [[ -n "$EMAIL" ]]; then
        tls_config="tls $EMAIL"
      fi

      local caddyfile="/etc/caddy/Caddyfile"
      local template="$REPO_DIR/deploy/caddy/Caddyfile.template"
      if [[ -f "$template" ]]; then
        sed -e "s|{\$DOMAIN}|$DOMAIN|g" \
            -e "s|{\$TLS_CONFIG}|$tls_config|g" \
            "$template" > "$caddyfile"
        systemctl enable --now caddy
        systemctl reload caddy || systemctl restart caddy
        log "Caddy configured and active for domain https://$DOMAIN"
      fi
    else
      log "No domain provided. Caddy setup skipped; CloudHarness loopback available at http://127.0.0.1:3100"
    fi
  elif [[ "$INGRESS_MODE" == "tunnel" ]]; then
    if [[ -n "$TUNNEL_TOKEN" ]]; then
      printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" > "$CONFIG_DIR/tunnel.env"
      chmod 0600 "$CONFIG_DIR/tunnel.env"
      log "Cloudflare Tunnel credentials configured."
    fi
  fi
}

install_systemd_and_tools() {
  log "Installing systemd units and administrative CLI utilities..."
  chmod 0755 "$REPO_DIR/deploy/scripts/service-compose.sh"
  install -m 0644 "$REPO_DIR/deploy/systemd/cloud-harness-mcp.service" /etc/systemd/system/cloud-harness-mcp.service
  install -m 0755 "$REPO_DIR/deploy/scripts/deploy-release.sh" /usr/local/sbin/cloud-harness-deploy
  install -m 0755 "$REPO_DIR/deploy/scripts/rollback-release.sh" /usr/local/sbin/cloud-harness-rollback
  install -m 0755 "$REPO_DIR/deploy/scripts/upgrade-nginx-dashboard.sh" /usr/local/sbin/cloud-harness-upgrade-nginx
  install -m 0755 "$REPO_DIR/deploy/scripts/service-compose.sh" /usr/local/sbin/cloud-harness-service-compose
  install -m 0755 "$REPO_DIR/bin/cloudharness" /usr/local/bin/cloudharness
  systemctl daemon-reload
}

execute_first_deployment() {
  log "Executing authoritative deployment for release $RELEASE_SHA..."
  /usr/local/sbin/cloud-harness-deploy "$RELEASE_SHA"
}

output_client_configuration() {
  local token endpoint client_config_file
  token=$(grep '^MCP_BEARER_TOKEN=' "$CONFIG_DIR/runtime.env" | cut -d'=' -f2-)
  client_config_file="$CONFIG_DIR/client-config.json"

  if [[ -n "$DOMAIN" ]]; then
    endpoint="https://$DOMAIN/mcp"
  else
    endpoint="http://127.0.0.1:3100/mcp"
  fi

  cat > "$client_config_file" <<EOF
{
  "mcpServers": {
    "cloud-harness": {
      "url": "$endpoint",
      "headers": {
        "Authorization": "Bearer $token"
      }
    }
  }
}
EOF
  chmod 0600 "$client_config_file"

  cat <<EOF

================================================================================
           CloudHarness MCP Server Successfully Installed & Deployed!
================================================================================

Server Status:
  - Systemd Service: active (running)
  - Ingress Endpoint: $endpoint
  - Management CLI: cloudharness (try: cloudharness status)

Client Configuration (Claude Desktop / Cursor):
Configuration snippet saved to root-only file: $client_config_file

Copy the following JSON into:
  - Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json
  - Cursor: .cursor/mcp.json

{
  "mcpServers": {
    "cloud-harness": {
      "url": "$endpoint",
      "headers": {
        "Authorization": "Bearer $token"
      }
    }
  }
}

================================================================================
EOF
}
main() {
  require_root
  parse_args "$@"
  preflight_checks
  resolve_ingress_inputs
  install_dependencies
  bootstrap_directories
  checkout_repository
  bootstrap_secrets
  configure_ingress
  install_systemd_and_tools
  execute_first_deployment
  output_client_configuration
}
main "$@"
