#!/usr/bin/env bash
set -euo pipefail

BRIDGE_NAME="${DEPENDENCY_NETWORK_NAME:-cloud-harness-dependency-access}"
BRIDGE_IF="${DEPENDENCY_BRIDGE_INTERFACE:-chm-egress0}"
SUBNET="${DEPENDENCY_BRIDGE_SUBNET:-172.30.240.0/24}"
DNS_RESOLVERS=$(echo "${DEPENDENCY_DNS_RESOLVERS:-8.8.8.8,1.1.1.1}" | tr ',' ' ')

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
NAT_CHAIN="CHM-NAT-$VERSION"
TMP_RESTORE=$(mktemp /tmp/chm-firewall-restore.XXXXXX)
chmod 0644 "$TMP_RESTORE"
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
  echo "-A $EGRESS_CHAIN -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited"
  echo "-A $EGRESS_CHAIN -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited"
  
  for resolver in $DNS_RESOLVERS; do
    echo "-A $EGRESS_CHAIN -p udp -d $resolver --dport 53 -j ACCEPT"
    echo "-A $EGRESS_CHAIN -p tcp -d $resolver --dport 53 -j ACCEPT"
  done
  
  echo "-A $EGRESS_CHAIN -p tcp --dport 80 -j ACCEPT"
  echo "-A $EGRESS_CHAIN -p tcp --dport 443 -j ACCEPT"
  echo "-A $EGRESS_CHAIN -j REJECT --reject-with icmp-port-unreachable"
  echo "COMMIT"
  
  echo "*nat"
  echo ":$NAT_CHAIN - [0:0]"
  echo "-F $NAT_CHAIN"
  echo "-A $NAT_CHAIN -p tcp -m multiport --dports 80,443 -j MASQUERADE"
  for resolver in $DNS_RESOLVERS; do
    echo "-A $NAT_CHAIN -p udp -d $resolver --dport 53 -j MASQUERADE"
    echo "-A $NAT_CHAIN -p tcp -d $resolver --dport 53 -j MASQUERADE"
  done
  echo "COMMIT"
} > "$TMP_RESTORE"

# 3. Test syntax before applying under noflush mode
if ! $SUDO iptables-restore -w 10 -n --test < "$TMP_RESTORE"; then
  echo "ERROR: iptables-restore syntax validation failed" >&2
  exit 1
fi

$SUDO iptables-restore -w 10 --noflush < "$TMP_RESTORE"
# 4. Move each managed jump to rule 1 atomically. Existing exact copies are
# removed by rule specification (never by position, which races with
# concurrent writers such as tailscaled or ufw) and the single jump is
# re-inserted at the head in the same iptables-restore transaction. Specs must
# match the canonical form printed by `iptables -S`.
INPUT_JUMP="-i $BRIDGE_IF -j $INPUT_CHAIN"
EGRESS_JUMP="-i $BRIDGE_IF -j $EGRESS_CHAIN"
NAT_JUMP="-s $SUBNET -j $NAT_CHAIN"

# Print "-D" lines for every existing exact copy of a jump, then one "-I 1".
emit_head_move() {
  local table="$1" chain="$2" spec="$3" rules count i
  rules=$($SUDO iptables -w 10 -t "$table" -S "$chain")
  count=$(awk -v want="-A $chain $spec" '$0 == want { n++ } END { print n + 0 }' <<<"$rules")
  for ((i = 0; i < count; i++)); do
    echo "-D $chain $spec"
  done
  echo "-I $chain 1 $spec"
}

# Brace groups (not command substitution) keep errexit active, so a failed
# `iptables -S` aborts before an incomplete move is applied.
{
  echo "*filter"
  emit_head_move filter INPUT "$INPUT_JUMP"
  emit_head_move filter DOCKER-USER "$EGRESS_JUMP"
  echo "COMMIT"
} > "$TMP_RESTORE"
$SUDO iptables-restore -w 10 --noflush < "$TMP_RESTORE"

{
  echo "*nat"
  emit_head_move nat POSTROUTING "$NAT_JUMP"
  echo "COMMIT"
} > "$TMP_RESTORE"
$SUDO iptables-restore -w 10 --noflush < "$TMP_RESTORE"

echo "cloud-harness-dependency-firewall: committed transactional policy successfully"
