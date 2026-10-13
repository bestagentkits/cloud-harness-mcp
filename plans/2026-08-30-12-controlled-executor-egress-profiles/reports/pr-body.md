## Outcome
Replace the broad `bridge` executor escape hatch with explicit, fail-closed executor egress profiles (`network-none`, `dependency-access`) enforced below MCP tool policy. Closes #12.

## Implementation
- **Contracts:** `ExecutorNetworkProfileSchema` (`network-none | dependency-access`) and `WorkspaceNetworkExposureSchema` (adds `local-host`), `DEPENDENCY_EGRESS_UNAVAILABLE` error code, `workspace_open` accepts `networkProfile` and rejects legacy `networkMode` with `INVALID_INPUT`. `WorkspaceCapabilitiesSchema.networkProfile` replaces the free string.
- **Host network & firewall:** dedicated `cloud-harness-dependency-access` bridge (`chm-egress0`, ICC off, default masquerade off, IPv6 off) provisioned with a single transactional `iptables-restore` commit (`deploy/scripts/setup-dependency-firewall.sh`). Deny loopback-to-host, Docker/control-plane, RFC 1918, CGNAT, link-local, and cloud-metadata ranges before allowing public DNS and TCP 80/443; scoped NAT only.
- **Attestation:** dedicated `cloud-harness-network-guard` (`NET_ADMIN`-only) image; `HostFirewallAttestor` verifies exact Docker network config plus the ordered ruleset — managed jump is the first rule of `INPUT`/`DOCKER-USER`, no broad ACCEPT/FORWARD bypass, deny-before-allow, mandatory scoped NAT — before every dependency executor start and during reaper drift checks.
- **Fail-closed lifecycle:** unavailable or drifted policy quarantines the workspace (`NETWORK_QUARANTINED`), stops every workspace-labeled container (including privileged ephemerals), emits a redacted `network_profile.drift_detected` audit event, retries removal, and recovers only after fresh attestation. Never falls back to broad bridge egress. `runPrivilegedEphemeralExec` and `ensureActiveExecutor` re-attest for dependency-access.
- **State:** transactional v4→v5 SQLite migration (`none→network-none`, `bridge→dependency-access`), preserving FK child rows and `mutation_lock_count`, running `foreign_key_check` before commit, rejecting unknown legacy values; fresh DBs bootstrap at v1 then migrate to v5.
- **Docs & skill:** updated `docs/`, `docs-site/`, README, `.env.example`, bootstrap script, and the Cloud Harness skill; regenerated reference and synced plugin.

## Verification
- `npm run test:unit` — 497 passing (adds attestor ordering/bypass, v4→v5 migration FK/mutation-lock, fresh-DB v5 tests).
- `npm run lint`, `npm run typecheck`, `npm run verify:compose` — green.
- Negative integration matrix (`test/integration/dependency-egress.docker.test.ts`) provisions the real firewall and asserts metadata/RFC1918/control-plane/disallowed-port blocking with positive-control canaries; gated to Linux + `CHM_DEPENDENCY_EGRESS_TEST=1` (not runnable on the CI Windows host).

## Acceptance Criteria
- [x] Tool/command text cannot bypass the boundary (enforced in host netfilter below the executor).
- [x] Dependency-enabled workspaces cannot reach control-plane or metadata endpoints.
- [x] Existing no-network workspaces preserve behavior; state migrates safely.
