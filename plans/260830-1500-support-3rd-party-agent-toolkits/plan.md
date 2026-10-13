---
issue: 136
title: "Support and Pre-install Third-Party Agent Toolkits (Open Source & AgentKit)"
status: completed
route: feature
mode: official
branch: feat-support-3rd-toolkits
created_at: 2026-08-30
---

# Implementation Plan: Third-Party Agent Toolkits Support

## Overview
Implement safe, reproducible, offline-compatible support for third-party open-source agent toolkits (`mattpocock/skills`, `obra/superpowers`, custom Git repositories) and proprietary toolkits (`bestagentkits/agentkit`) in CloudHarness remote workspaces. 

The architecture features runner-mediated Content-Addressed Storage (CAS) under `TOOLKIT_CACHE_ROOT`, transactional SQLite state migrations in `principal-store.ts` (v5 $\rightarrow$ v6), strict secret purpose classification (`purpose: "provisioning" | "runtime"`), disposable helper containers (Git clone & AgentKit export) running on an `internal: true` Docker network egress-gated by a dual-homed `provisioning-proxy`, read-only mount injection at `/opt/cloud-harness/owner-skills:ro`, descriptor-safe workspace patching, and truthful capability reporting across MCP clients.

Phase 0 serves as a **HARD STOP gate**: all downstream AgentKit implementation remains blocked until vendor retention/redistribution terms are verified and live CLI non-interactive export/offline recovery is empirically proven.

## Architectural Blueprint
```text
MCP Client / Dashboard -> workspace_open { toolkits: [presets, git] }
  -> Runner validates request, checks owner-isolated CAS (TOOLKIT_CACHE_ROOT)
     ├─ Cache Hit  -> Reuse immutable bundle (0 network, P95 < 1s)
     └─ Cache Miss -> Disposable runner helpers (Git clone & ak export) on internal: true provisioning network
                      ├── Direct internet/raw sockets fail: ENETUNREACH
                      ├── Traffic routed via dual-homed provisioning-proxy:3128 -> runner-egress
                      ├── Git clone & recursive skill normalization (mattpocock, superpowers, custom git)
                      ├── ak kit init --target portable --out /staging (pipe-injected AGENTKIT_API_KEY)
                      └── Scan secret canary, compute full-tree SHA256, fsync & atomic publish to CAS
  -> Create Executor Container (networkMode: "none" default)
     ├─ Bind-mount /job/toolkit-projection/owner-skills:/opt/cloud-harness/owner-skills:ro (Clean Git)
     ├─ Optional staged workspace patch into .cloud-harness/skills (Workspace Scope, UID 10001)
     └─ Worker resolves: built-in (rank 4) > owner (rank 3) > workspace (rank 2) > repository (rank 1)
```

## Acceptance Criteria
- [x] Phase 0 feasibility gates formally resolved: secret purpose classification data model prevents `AGENTKIT_API_KEY` leakage into runtime containers; proprietary AgentKit preset deferred pending vendor entitlement proof.
- [x] `workspace_open` accepts zero, one, or multiple toolkit selections via a strict discriminated union (`preset` | `git`), with omitted/empty preserving pristine default behavior.
- [x] Executor runs with `networkMode: "none"` by default; warm opens operate with zero network and add $\le 1.0\text{s}$ P95 latency.
- [x] `AGENTKIT_API_KEY` is classified as `purpose: "provisioning"` and strictly excluded from runtime container environment (`docker inspect`).
- [x] ALL helper containers run attached strictly to an `internal: true` provisioning network; direct raw socket connections fail with `ENETUNREACH`; all egress traverses dual-homed `provisioning-proxy`.
- [x] Remote executor mounts composed owner skills read-only at `/opt/cloud-harness/owner-skills:ro`; `owner` scope leaves `git status --porcelain` 100% clean.
- [x] Workspace-scope writes require explicit confirmation (`allowToolkitWorkspaceChanges: true`), enforce canonical root containment without following ancestor symlinks, and fail on existing non-identical files without overwrite.
- [x] Same-tier duplicate skill names between owner toolkits fail deterministically (`CONFLICT`); 4-tier precedence (`built-in > owner > workspace > repository`) remains strictly enforced with shadowed candidate reporting.
- [x] Superpowers and open-source presets report truthful capability metadata (provisioned skills count and catalog verification status).
- [x] Replaying an idempotencyKey compares canonical request fingerprints; mismatched request returns `CONFLICT`; recovery restores exact pinned digests.
- [x] Full-tree bundle SHA-256 digest covers all paths, content, and executable modes; kernel-enforced `:ro` mounts protect owner/built-in tiers, while snapshot-first validation mitigates in-container filesystem races for mutable tiers.
- [x] StateStore migrations and rollbacks in `principal-store.ts` are 100% transactional.
- [x] All unit, integration, Docker sandbox, compose boundary, and contract tests pass.

## Phases
0. [Phase 0: Feasibility Gates, Secret Purpose Classification & Vendor Proof](phase-00-feasibility-gates-and-secret-purpose.md) - Status: completed
1. [Phase 1: Contracts, Schemas & Public Interfaces](phase-01-contracts-schemas-and-secret-purpose.md) - Status: completed
2. [Phase 2: Runner CAS, Cache Manager & State Schema Migration](phase-02-runner-cas-cache-manager-and-state-schema.md) - Status: completed
3. [Phase 3: Preset Adapters & Disposable Provisioning Helpers](phase-03-preset-adapters-and-provisioning-helpers.md) - Status: completed
4. [Phase 4: Mount Injection, Workspace Patching & Worker Resolver](phase-04-mount-injection-workspace-patching-and-worker-resolver.md) - Status: completed
5. [Phase 5: Dashboard Workspace Opening, Toolkit Selector & Preview BFF](phase-05-dashboard-workspace-opening-and-preview-bff.md) - Status: completed
6. [Phase 6: Adversarial Security, Recovery Tests, Docs & Plugin Sync](phase-06-adversarial-security-recovery-tests-and-docs-sync.md) - Status: completed

## Red Team Review

### Session — 2026-08-30
**Findings:** 20 total (20 accepted, 0 rejected)  
**Severity breakdown:** 11 Critical, 9 High

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Secret-purpose persistence boundary missing in metadata schema | Critical | Accept | Phase 0, Phase 1, Phase 2 |
| 2 | Missing `consumeProvisioningSecret` reader API | Critical | Accept | Phase 0, Phase 3 |
| 3 | Existing runtime secret reclassification gate | Critical | Accept | Phase 0, Phase 1 |
| 4 | Universal structural network firewall (internal network + dual-homed proxy across Git and AgentKit) | Critical | Accept | Phase 0, Phase 3, Phase 6 |
| 5 | Asynchronous SSRF validation & DNS rebinding hole | Critical | Accept | Phase 1, Phase 3 |
| 6 | Workspace-scope patching symlink escape & TOCTOU hole | Critical | Accept | Phase 4 |
| 7 | Full-tree hash TOCTOU execution window | Critical | Accept | Phase 4 |
| 8 | Idempotency replay ignores request fingerprint | Critical | Accept | Phase 2, Phase 4 |
| 9 | Atomicity gaps in bundle pin vs lifecycle transitions | Critical | Accept | Phase 2, Phase 4 |
| 10 | GC vs acquisition race condition & lock ordering | Critical | Accept | Phase 2 |
| 11 | State migration owner must be `principal-store.ts` (v5 $\rightarrow$ v6) with rollback | Critical | Accept | Phase 2 |
| 12 | Pinned `ak` binary missing from Docker image specifications | High | Accept | Phase 0, Phase 3 |
| 13 | `toolkitNetworkPolicy: "cache-only"` lacks runner config wiring | High | Accept | Phase 2, Phase 3 |
| 14 | Tenant foreign keys missing on proposed toolkit state tables | High | Accept | Phase 2 |
| 15 | Hardlink projection chmods corrupt immutable CAS inodes | High | Accept | Phase 4 |
| 16 | Git object ID contract must support 40 and 64 hex characters | High | Accept | Phase 1, Phase 3 |
| 17 | Reuse `RepositoryCacheManager.acquireToolkitCacheMirror()` on internal network | High | Accept | Phase 3 |
| 18 | Avoid redundant refcounts; use mark-and-sweep from state table | High | Accept | Phase 2 |
| 19 | Durable CAS publication requires fsync ordering | High | Accept | Phase 2 |
| 20 | Recovery precondition must validate bundle digests before ACTIVE | High | Accept | Phase 4, Phase 6 |

### Whole-Plan Consistency Sweep
- All phase files updated to reflect universal helper network containment (`cloud-harness-provisioning`, `internal: true`) for both Git and AgentKit helpers, dual-homed `provisioning-proxy`, `principal-store.ts` v5 $\rightarrow$ v6 migration authority, `TOOLKIT_CACHE_ROOT` volume contract, secret purpose classification (`purpose: "provisioning"`), reflink/copy projections without chmod mutation, canonical request fingerprinting, and descriptor-safe workspace patching.
- Zero unresolved contradictions across all 7 phase files and `plan.md`.
