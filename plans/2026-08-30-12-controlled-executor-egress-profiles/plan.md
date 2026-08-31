# Plan: Enforce Controlled Executor Egress Profiles (Issue #12)

Status: completed
Implementation Route: feature
Ship Mode: official
Source Issue: https://github.com/bestagentkits/cloud-harness-mcp/issues/12

## Overview
Replace the broad, unrestricted bridge-network escape hatch with explicit executor egress profiles enforced below MCP tool policy. The default profile is `network-none` (Docker `--network none`). The opt-in profile is `dependency-access`, which permits public DNS (UDP/TCP 53) and public HTTP/HTTPS (TCP 80/443) only, while strictly denying access to loopback (to host/gateway), Docker daemon, Compose control plane, private RFC 1918 subnets, link-local addresses, and cloud metadata (`169.254.169.254`).

## Phases
- [x] [Phase 1: Contracts, Tool Schemas, and Capabilities](phase-01-contracts-and-schemas.md)
- [x] [Phase 2: Host Network & Transactional Firewall Attestation](phase-02-host-network-and-firewall-attestation.md)
- [x] [Phase 3: Runner NetworkProfileManager, WorkspaceService & State Migration](phase-03-runner-network-manager-and-state-migration.md)
- [x] [Phase 4: API, Dashboard, Cloud Harness Skill & Documentation](phase-04-api-dashboard-skill-and-docs.md)
- [x] [Phase 5: Comprehensive Negative Integration & Unit Tests](phase-05-negative-integration-and-unit-tests.md)

## Core Architectural Invariants (Kongming Advisory Sealed)
1. **Contracts:**
   - `ExecutorNetworkProfileSchema = z.enum(['network-none', 'dependency-access'])`.
   - `WorkspaceNetworkExposureSchema = z.enum(['network-none', 'dependency-access', 'local-host'])`.
   - `DEPENDENCY_EGRESS_UNAVAILABLE` added to `ErrorCodeSchema`.
   - Strict rejection of legacy `networkMode` at the input boundary before stripping.
2. **Host Network & Attestation:**
   - Dedicated bridge `cloud-harness-dependency-access` (`chm-egress0`) with `ICC=false`, `enable_ip_masquerade=false`, `EnableIPv6=false`.
   - Transactional rule swap: create versioned target chains `CHM-INPUT-v1` and `CHM-EGRESS-v1`, populate rules, then atomically head-insert Rule 1 in `INPUT` and `DOCKER-USER` under xtables lock.
   - Comprehensive attestation inspecting `FORWARD -> DOCKER-USER` link, Rule 1 position, complete canonical rule structure, and narrow NAT.
3. **Quarantine & Drift Handling:**
   - Periodic reaper attestation. If firewall drift is detected, active `dependency-access` containers are fenced, stopped, and marked `NETWORK_QUARANTINED`, emitting audit event `network_profile.drift_detected`.
4. **State Migration:**
   - Transactional SQLite v4 -> v5 migration in `migratePrincipalSchema()` with foreign-key validation.
   - Legacy `bridge` containers stopped and recreated under controlled bridge before Runner readiness.
5. **DNS & Execution Integration:**
   - Pass `--dns <resolver>` flags for all configured public resolvers.
   - Apply profile resolver to all user/repo execution paths (standard executor, approved root execution).
