#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "upgrade-nginx-dashboard.sh must run as root" >&2
  exit 1
fi

site=/etc/nginx/sites-available/cloud-harness-mcp.conf
enabled=/etc/nginx/sites-enabled/cloud-harness-mcp.conf
runtime_config=/etc/cloud-harness-mcp/runtime."env"
backup_root=/etc/cloud-harness-mcp/nginx-backups

[[ -f $site && -f $runtime_config ]] || { echo "Cloud Harness nginx site or runtime configuration is missing" >&2; exit 2; }
[[ -L $enabled && $(readlink -f "$enabled") == "$site" ]] || { echo "enabled Cloud Harness nginx site is not the managed target" >&2; exit 3; }

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

mapfile -t blocks < <(awk -v configured="$public_hosts" '
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
if [[ $dashboard_entry_count -eq 1 && $dashboard_prefix_count -eq 1 ]] &&
   grep -Fq 'proxy_pass http://127.0.0.1:3100/dashboard;' "$block_file" &&
   grep -Fq 'proxy_pass http://127.0.0.1:3100/dashboard/;' "$block_file"; then
  nginx -t
  echo "Cloud Harness dashboard nginx routes are already installed"
  exit 0
fi
if [[ $dashboard_entry_count -ne 0 || $dashboard_prefix_count -ne 0 ]] || grep -Fq '127.0.0.1:3100/dashboard' "$block_file"; then
  echo "existing dashboard nginx routing is not the managed shape; refusing to overwrite it" >&2
  exit 6
fi

awk -v closing="$end_line" '
  NR == closing {
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
  { print }
' "$site" > "$rendered"

install -d -m 0700 "$backup_root"
backup="$backup_root/cloud-harness-mcp.conf.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$site" "$backup"
restore() {
  cp -a "$backup" "$site"
  nginx -t && systemctl reload nginx || true
}
trap 'status=$?; if [[ $status -ne 0 ]]; then restore; fi; rm -f -- "$block_file" "$rendered"; exit "$status"' EXIT

chmod --reference="$site" "$rendered"
chown --reference="$site" "$rendered"
cp --preserve=mode,ownership "$rendered" "$site"
nginx -t
systemctl reload nginx
trap 'rm -f -- "$block_file" "$rendered"' EXIT
echo "installed Cloud Harness dashboard nginx routes; backup: $backup"
