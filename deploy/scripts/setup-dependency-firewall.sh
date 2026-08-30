#!/usr/bin/env bash
set -euo pipefail

BRIDGE_NAME="${DEPENDENCY_NETWORK_NAME:-cloud-harness-dependency-access}"
BRIDGE_IF="${DEPENDENCY_BRIDGE_INTERFACE:-chm-egress0}"
SUBNET="${DEPENDENCY_BRIDGE_SUBNET:-172.30.240.0/24}"
DNS_RESOLVERS="${DEPENDENCY_DNS_RESOLVERS:-8.8.8.8 1.1.1.1}"

SUDO=""
if [[ $(id -u) -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi
# 1. Ensure dedicated Docker bridge network exists
if ! docker network inspect "$BRIDGE_NAME" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --opt "com.docker.network.bridge.name=$BRIDGE_IF" \
    --opt "com.docker.network.bridge.enable_icc=false" \
    --opt "com.docker.network.bridge.enable_ip_masquerade=false" \
    --subnet "$SUBNET" \
    --ipv6=false \
    --label "cloud-harness.managed=true" \
    --label "cloud-harness.network-profile=dependency-access" \
    "$BRIDGE_NAME"
fi

# 2. Build complete transactional iptables-restore payload
VERSION="v1"
INPUT_CHAIN="CHM-INPUT-$VERSION"
EGRESS_CHAIN="CHM-EGRESS-$VERSION"

TMP_RESTORE=$(mktemp /tmp/chm-firewall-restore.XXXXXX)
trap 'rm -f "$TMP_RESTORE"' EXIT

{
  echo "*filter"
  echo ":$INPUT_CHAIN - [0:0]"
  echo ":$EGRESS_CHAIN - [0:0]"
  echo "-F $INPUT_CHAIN"
  echo "-F $EGRESS_CHAIN"
  
  # INPUT chain: Reject any traffic from bridge to host/gateway
  echo "-A $INPUT_CHAIN -j REJECT --reject-with icmp-port-unreachable"
  
  # EGRESS chain: L3 filtering for forwarded packets
  echo "-A $EGRESS_CHAIN -m conntrack --ctstate ESTABLISHED -j ACCEPT"
  echo "-A $EGRESS_CHAIN -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited"
  echo "-A $EGRESS_CHAIN -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited"
  echo "-A $EGRESS_CHAIN -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited"
  echo "-A $EGRESS_CHAIN -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited"
  echo "-A $EGRESS_CHAIN -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited"
  echo "-A $EGRESS_CHAIN -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited"
  echo "-A $EGRESS_CHAIN -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited"
  
  for resolver in $DNS_RESOLVERS; do
    echo "-A $EGRESS_CHAIN -p udp -d $resolver --dport 53 -j ACCEPT"
    echo "-A $EGRESS_CHAIN -p tcp -d $resolver --dport 53 -j ACCEPT"
  done
  
  echo "-A $EGRESS_CHAIN -p tcp --dport 80 -j ACCEPT"
  echo "-A $EGRESS_CHAIN -p tcp --dport 443 -j ACCEPT"
  echo "-A $EGRESS_CHAIN -j REJECT --reject-with icmp-port-unreachable"
  
  # Atomically ensure jump rules at Rule 1
  echo "-I INPUT 1 -i $BRIDGE_IF -j $INPUT_CHAIN"
  echo "-I DOCKER-USER 1 -i $BRIDGE_IF -j $EGRESS_CHAIN"
  echo "COMMIT"
  
  echo "*nat"
  echo "-A POSTROUTING -s $SUBNET -p tcp -m multiport --dports 80,443 -j MASQUERADE"
  for resolver in $DNS_RESOLVERS; do
    echo "-A POSTROUTING -s $SUBNET -p udp -d $resolver --dport 53 -j MASQUERADE"
    echo "-A POSTROUTING -s $SUBNET -p tcp -d $resolver --dport 53 -j MASQUERADE"
  done
  echo "COMMIT"
} > "$TMP_RESTORE"

# 3. Test syntax before applying
if ! $SUDO iptables-restore --test < "$TMP_RESTORE"; then
  echo "ERROR: iptables-restore syntax validation failed" >&2
  exit 1
fi

# 4. Commit atomic transaction under xtables lock
$SUDO iptables-restore -w 10 --noflush < "$TMP_RESTORE"

# 5. Deduplicate jump rules created by earlier runs. The restore inserted the
# authoritative jump at position 1, so remove any *later* duplicate (highest
# line number first) and never the position-1 rule that guarantees precedence.
dedup_jump() {
  local chain="$1"
  while :; do
    local nums
    nums=$($SUDO iptables -w 10 -L "$chain" --line-numbers -n | awk -v ifc="$BRIDGE_IF" -v tgt="$2" '$2==tgt && $0 ~ ("in "ifc) {print $1}')
    local count
    count=$(printf '%s\n' "$nums" | grep -c .)
    [ "$count" -le 1 ] && break
    local last
    last=$(printf '%s\n' "$nums" | tail -n1)
    $SUDO iptables -w 10 -D "$chain" "$last" || break
  done
}
dedup_jump INPUT "$INPUT_CHAIN"
dedup_jump DOCKER-USER "$EGRESS_CHAIN"
echo "cloud-harness-dependency-firewall: committed transactional policy successfully"
