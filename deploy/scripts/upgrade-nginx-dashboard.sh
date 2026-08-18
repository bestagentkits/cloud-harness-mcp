#!/usr/bin/env bash
set -euo pipefail
umask 077

test_root=${CLOUD_HARNESS_NGINX_TEST_ROOT:-}
if [[ -n $test_root ]]; then
  [[ ${EUID:-$(id -u)} -ne 0 && -f $test_root/.cloud-harness-nginx-test-root ]] || {
    echo "invalid Cloud Harness nginx test root" >&2
    exit 1
  }
  site=$test_root/etc/nginx/sites-available/cloud-harness-mcp.conf
  enabled=$test_root/etc/nginx/sites-enabled/cloud-harness-mcp.conf
  runtime_config=$test_root/etc/cloud-harness-mcp/runtime."env"
  backup_root=$test_root/etc/cloud-harness-mcp/nginx-backups
  nginx_command=$test_root/bin/nginx
  systemctl_command=$test_root/bin/systemctl
elif [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "upgrade-nginx-dashboard.sh must run as root" >&2
  exit 1
else
  site=/etc/nginx/sites-available/cloud-harness-mcp.conf
  enabled=/etc/nginx/sites-enabled/cloud-harness-mcp.conf
  runtime_config=/etc/cloud-harness-mcp/runtime."env"
  backup_root=/etc/cloud-harness-mcp/nginx-backups
  nginx_command=/usr/sbin/nginx
  systemctl_command=/usr/bin/systemctl
fi

[[ -f $site && -f $runtime_config ]] || { echo "Cloud Harness nginx site or runtime configuration is missing" >&2; exit 2; }
[[ -L $enabled && $(readlink "$enabled") == "$site" ]] || { echo "enabled Cloud Harness nginx site is not the managed target" >&2; exit 3; }
[[ -x $nginx_command && -x $systemctl_command ]] || { echo "required nginx management command is missing" >&2; exit 2; }

public_hosts=$(awk -F= '$1 == "API_PUBLIC_HOSTS" { print substr($0, index($0, "=") + 1); found++ } END { if (found != 1) exit 1 }' "$runtime_config") || {
  echo "API_PUBLIC_HOSTS must appear exactly once" >&2
  exit 4
}
IFS=, read -ra configured_hosts <<< "$public_hosts"
[[ ${#configured_hosts[@]} -gt 0 ]] || { echo "API_PUBLIC_HOSTS must not be empty" >&2; exit 4; }
for host in "${configured_hosts[@]}"; do
  [[ $host =~ ^[A-Za-z0-9.-]+$ && $host != *..* && $host != .* && $host != *. ]] || {
    echo "API_PUBLIC_HOSTS contains an invalid hostname" >&2
    exit 4
  }
done

blocks=()
while IFS= read -r block; do blocks+=("$block"); done < <(awk -v configured="$public_hosts" '
  function brace_count(value, needle, count, pos) {
    count = 0
    while ((pos = index(value, needle)) > 0) {
      count++
      value = substr(value, pos + 1)
    }
    return count
  }
  BEGIN {
    count = split(configured, names, ",")
    for (cursor = 1; cursor <= count; cursor++) wanted[names[cursor]] = 1
  }
  /^[[:space:]]*server[[:space:]]*\{/ && depth == 0 {
    in_server = 1
    start = NR
    matches_host = 0
    tls = 0
  }
  in_server {
    if ($1 == "server_name") {
      for (i = 2; i <= NF; i++) {
        name = $i
        sub(/;$/, "", name)
        if (wanted[name]) matches_host = 1
      }
    }
    if ($1 == "ssl_certificate" || ($1 == "listen" && $0 ~ /(^|[[:space:]])443([[:space:];]|$)/)) tls = 1
    depth += brace_count($0, "{") - brace_count($0, "}")
    if (depth == 0) {
      if (matches_host) print start ":" NR ":" tls
      in_server = 0
    }
  }
' "$site")

selected=
tls_count=0
for block in "${blocks[@]}"; do
  if [[ $block == *:1 ]]; then
    selected=$block
    ((tls_count += 1))
  fi
done
if [[ $tls_count -gt 1 || ($tls_count -eq 0 && ${#blocks[@]} -ne 1) ]]; then
  echo "could not select one unambiguous nginx server block from API_PUBLIC_HOSTS" >&2
  exit 5
fi
if [[ $tls_count -eq 0 ]]; then selected=${blocks[0]:-}; fi
[[ -n $selected ]] || { echo "nginx server block for API_PUBLIC_HOSTS was not found" >&2; exit 5; }

IFS=: read -r start_line end_line _ <<< "$selected"
block_file=$(mktemp)
rendered=$(mktemp)
trap 'rm -f -- "$block_file" "$rendered"' EXIT
sed -n "${start_line},${end_line}p" "$site" > "$block_file"

dashboard_entry_count=$(grep -Fxc '    location = /dashboard {' "$block_file" || true)
dashboard_prefix_count=$(grep -Fxc '    location ^~ /dashboard/ {' "$block_file" || true)
api_key_count=$(grep -Fxc '    location = /mcp-api-key {' "$block_file" || true)
dashboard_entry_block=$(sed -n '/^    location = \/dashboard {$/,/^    }$/p' "$block_file")
dashboard_prefix_block=$(sed -n '/^    location \^~ \/dashboard\/ {$/,/^    }$/p' "$block_file")
api_key_block=$(sed -n '/^    location = \/mcp-api-key {$/,/^    }$/p' "$block_file")
normalize_block() {
  sed -E \
    -e 's/[[:space:]]*#.*$//' \
    -e 's/^[[:space:]]+//' \
    -e 's/[[:space:]]+$//' \
    -e '/^$/d'
}
expected_dashboard_entry=$'location = /dashboard {\nproxy_pass http://127.0.0.1:3100/dashboard;\nproxy_set_header Host $host;\nproxy_set_header X-Forwarded-Proto $scheme;\n}'
expected_dashboard_prefix=$'location ^~ /dashboard/ {\nproxy_pass http://127.0.0.1:3100/dashboard/;\nproxy_set_header Host $host;\nproxy_set_header X-Forwarded-Proto $scheme;\n}'
expected_api_key=$'location = /mcp-api-key {\nproxy_pass http://127.0.0.1:3100/mcp-api-key;\nproxy_http_version 1.1;\nproxy_set_header Host $host;\nproxy_set_header X-Forwarded-Proto $scheme;\nproxy_set_header Connection "";\nproxy_buffering off;\nproxy_request_buffering off;\nproxy_cache off;\nproxy_read_timeout 3600s;\nadd_header X-Accel-Buffering no always;\n}'

dashboard_installed=0
if [[ $dashboard_entry_count -eq 1 && $dashboard_prefix_count -eq 1 &&
      $(normalize_block <<< "$dashboard_entry_block") == "$expected_dashboard_entry" &&
      $(normalize_block <<< "$dashboard_prefix_block") == "$expected_dashboard_prefix" ]]; then
  dashboard_installed=1
fi
api_key_installed=0
if [[ $api_key_count -eq 1 && $(normalize_block <<< "$api_key_block") == "$expected_api_key" ]]; then
  api_key_installed=1
fi

if [[ $dashboard_installed -eq 1 && $api_key_installed -eq 1 ]]; then
  "$nginx_command" -t
  echo "Cloud Harness dashboard and API-key nginx routes are already installed"
  exit 0
fi
if [[ $dashboard_installed -eq 0 ]] &&
   { [[ $dashboard_entry_count -ne 0 || $dashboard_prefix_count -ne 0 ]] || grep -Fq '127.0.0.1:3100/dashboard' "$block_file"; }; then
  echo "existing dashboard nginx routing is not the managed shape; refusing to overwrite it" >&2
  exit 6
fi
if [[ $api_key_installed -eq 0 ]] &&
   { [[ $api_key_count -ne 0 ]] || grep -Fq '127.0.0.1:3100/mcp-api-key' "$block_file"; }; then
  echo "existing API-key nginx routing is not the managed shape; refusing to overwrite it" >&2
  exit 7
fi

awk -v closing="$end_line" -v add_dashboard="$((1 - dashboard_installed))" -v add_api_key="$((1 - api_key_installed))" '
  NR == closing {
    if (add_api_key) {
      print "    location = /mcp-api-key {"
      print "        proxy_pass http://127.0.0.1:3100/mcp-api-key;"
      print "        proxy_http_version 1.1;"
      print "        proxy_set_header Host $host;"
      print "        proxy_set_header X-Forwarded-Proto $scheme;"
      print "        proxy_set_header Connection \"\";"
      print "        proxy_buffering off;"
      print "        proxy_request_buffering off;"
      print "        proxy_cache off;"
      print "        proxy_read_timeout 3600s;"
      print "        add_header X-Accel-Buffering no always;"
      print "    }"
      print ""
    }
    if (add_dashboard) {
      print "    location = /dashboard {"
      print "        proxy_pass http://127.0.0.1:3100/dashboard;"
      print "        proxy_set_header Host $host;"
      print "        proxy_set_header X-Forwarded-Proto $scheme;"
      print "    }"
      print ""
      print "    location ^~ /dashboard/ {"
      print "        proxy_pass http://127.0.0.1:3100/dashboard/;"
      print "        proxy_set_header Host $host;"
      print "        proxy_set_header X-Forwarded-Proto $scheme;"
      print "    }"
    }
  }
  { print }
' "$site" > "$rendered"

install -d -m 0700 "$backup_root"
backup="$backup_root/cloud-harness-mcp.conf.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$site" "$backup"
restore() {
  cp -a "$backup" "$site"
  "$nginx_command" -t && "$systemctl_command" reload nginx || true
}
trap 'status=$?; if [[ $status -ne 0 ]]; then restore; fi; rm -f -- "$block_file" "$rendered"; exit "$status"' EXIT

if [[ -n $test_root ]]; then
  chmod 0644 "$rendered"
  cp "$rendered" "$site"
else
  chmod --reference="$site" "$rendered"
  chown --reference="$site" "$rendered"
  cp --preserve=mode,ownership "$rendered" "$site"
fi
"$nginx_command" -t
"$systemctl_command" reload nginx
trap 'rm -f -- "$block_file" "$rendered"' EXIT
echo "installed Cloud Harness dashboard and API-key nginx routes; backup: $backup"
