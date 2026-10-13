# Phase 2: Host Network & Transactional Firewall Attestation

## Context Links
- `deploy/scripts/`
- `apps/runner/src/docker-engine.ts`
- `apps/runner/src/host-firewall-attestation.ts` (new)
- `scripts/verify-compose-boundaries.mjs`

## Requirements
1. **Dedicated Docker Network Provisioning:**
   - Create helper/script to ensure `cloud-harness-dependency-access` exists with:
     - Driver: `bridge`
     - Bridge interface name: `chm-egress0`
     - Subnet: configurable, default `172.30.240.0/24`
     - `com.docker.network.bridge.enable_icc=false`
     - `com.docker.network.bridge.enable_ip_masquerade=false`
     - `EnableIPv6=false`
2. **Transactional Firewall Rule Installation:**
   - Provide script / helper to install firewall rules atomically without empty-window race condition:
     - Generate complete iptables-restore payload or build versioned target chains `CHM-INPUT-v1` and `CHM-EGRESS-v1`.
     - Populate chains with:
       - `INPUT`: Terminal REJECT (`-i chm-egress0 -j REJECT --reject-with icmp-port-unreachable`).
       - `DOCKER-USER` (EGRESS):
         1. `conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`
         2. REJECT forbidden ranges: `169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `100.64.0.0/10`
         3. ACCEPT DNS UDP/TCP 53 to configured public resolvers
         4. ACCEPT TCP 80, 443 to non-forbidden destinations
         5. Terminal REJECT for all other destinations/ports
       - `POSTROUTING` (NAT):
         - Masquerade only for TCP 80, 443 and UDP/TCP 53 from `172.30.240.0/24`.
     - Atomically head-insert jump rules at Rule 1 (`-I INPUT 1 -i chm-egress0 -j CHM-INPUT-v1`, `-I DOCKER-USER 1 -i chm-egress0 -j CHM-EGRESS-v1`).
3. **Host Firewall Attestation Engine:**
   - Implement `HostFirewallAttestor` in runner:
     - Spawns an ephemeral verification probe running in host netns with `NET_ADMIN` via Docker socket.
     - Runs `iptables -C INPUT -i chm-egress0 -j ...` and `iptables -C DOCKER-USER -i chm-egress0 -j ...` at position 1.
     - Verifies rule integrity and returns structured status `{ ok: boolean, reason?: string }`.

## Validation
- Unit tests for payload generation and attestation parser.
