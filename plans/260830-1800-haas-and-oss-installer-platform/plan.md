---
title: "CloudHarness HaaS & OSS 1-Click Installer Platform"
status: in_progress
created: "2026-08-30"
version: "1.2.0"
references:
  - "plans/260817-0848-2-cloud-harness-next-steps/phase-04-tenant-isolation-and-scale-readiness.md"
phases:
  - id: "00"
    name: "Multi-Tenant Threat Model, ADR & Owner Go/No-Go Gate"
    file: "phase-00-threat-model-adr-and-isolation-gate.md"
    status: in_progress
    priority: P1
  - id: "01"
    name: "OSS 1-Click Installer & Production Compose Pipeline"
    file: "phase-01-oss-installer-and-tls-pipeline.md"
    status: in_progress
    priority: P1
  - id: "02"
    name: "Outbound Node Agent, Secure Enrollment & Dedicated Tenant Orchestration"
    file: "phase-02-node-agent-and-multi-node-orchestrator.md"
    status: pending
    priority: P1
  - id: "03"
    name: "Hybrid Metering & Double-Entry Billing Engine"
    file: "phase-03-hybrid-metering-and-billing-engine.md"
    status: pending
    priority: P1
  - id: "04"
    name: "Fail-Closed Firecracker MicroVM Multi-Tenant Runtime"
    file: "phase-04-dedicated-tenant-and-firecracker-runtime.md"
    status: pending
    priority: P1
  - id: "05"
    name: "GTM Distribution Portal, Registries & Client Guides"
    file: "phase-05-gtm-portal-and-docs-expansion.md"
    status: pending
    priority: P2
---

# Plan: CloudHarness HaaS & OSS 1-Click Installer Platform

## Executive Summary
Evolution of CloudHarness MCP from a single-owner self-hosted coding harness into a dual-model architecture:
1. **CloudHarness Community (OSS - Phase 01):** 100% MIT-licensed, single-command installer (`curl -fsSL https://get.cloudharness.io | bash`), automated TLS/Cloudflare tunnel provisioning, zero telemetry by default, loopback ingress preservation. **Independently executable immediately.**
2. **CloudHarness Cloud (HaaS - Phases 00, 02, 03, 04, 05):** Managed multi-node cluster control plane, outbound gRPC/mTLS node daemon with zero-leak enrollment, hybrid metering, double-entry credit ledger, and hardware-isolated multi-tenant execution. **Strictly gated behind Phase 00 Threat Model & ADR Owner Sign-Off.**

## Execution Gating & Isolation Prerequisites
- **Independent OSS Stream:** Phase 01 delivers the self-hosted community installer for single trusted owners. It requires no multi-tenancy and is immediately ready to implement.
- **Commercial Multi-Tenant Gate (Phase 00):** Incorporates all requirements from `plans/260817-0848-2-cloud-harness-next-steps/phase-04-tenant-isolation-and-scale-readiness.md`. Implementation of multi-tenant infrastructure (Phases 02, 03, 04) is strictly blocked until the Threat Model comparison, benchmarks, cost/SLO model, and formal ADR receive owner sign-off.
- **Fail-Closed Pooled Isolation:** Commercial Beta runs exclusively on dedicated single-tenant VMs. Public pooled GA is strictly gated on Phase 04 Firecracker KVM microVM verification with a mandatory fail-closed guarantee (never falling back to Docker).

## Phases & Deliverables

| Phase | File | Focus | Priority | Dependencies | Execution State |
|---|---|---|---|---|---|
| **Phase 00** | [`phase-00-threat-model-adr-and-isolation-gate.md`](phase-00-threat-model-adr-and-isolation-gate.md) | Multi-tenant Threat Model, Isolation Benchmarks, Cost/SLO, Formal ADR & Owner Sign-Off | **P1** | None | **Prerequisite for HaaS** |
| **Phase 01** | [`phase-01-oss-installer-and-tls-pipeline.md`](phase-01-oss-installer-and-tls-pipeline.md) | 1-Click Bash Installer, Let's Encrypt TLS / Cloudflare Tunnel, `cloud-harness-deploy` image build & canary | **P1** | None | **Ready to Cook (OSS)** |
| **Phase 02** | [`phase-02-node-agent-and-multi-node-orchestrator.md`](phase-02-node-agent-and-multi-node-orchestrator.md) | Outbound Node Agent, zero-leak enrollment (stdin/root file), PostgreSQL Registry, dedicated-tenant scheduler | **P1** | Phase 00, Phase 01 | Gated on Phase 00 ADR |
| **Phase 03** | [`phase-03-hybrid-metering-and-billing-engine.md`](phase-03-hybrid-metering-and-billing-engine.md) | Duration tracking, request counting, 15-minute auto-idle sleep, double-entry ledger, Polar.sh/Stripe | **P1** | Phase 02 | Gated on Phase 02 |
| **Phase 04** | [`phase-04-dedicated-tenant-and-firecracker-runtime.md`](phase-04-dedicated-tenant-and-firecracker-runtime.md) | Fail-Closed Firecracker MicroVM driver, jailer process, encrypted snapshot lifecycle (GA cluster) | **P1** | Phase 00, Phase 02, Phase 03 | Gated on Phase 00 & 03 |
| **Phase 05** | [`phase-05-gtm-portal-and-docs-expansion.md`](phase-05-gtm-portal-and-docs-expansion.md) | Official MCP Registry listings, Cursor/Claude/Codex connection guides, Docs site expansion | **P2** | Phase 01, Phase 03, Phase 04 | Gated on GA Runtime |

## Primary Artifact
When `--html` is requested, the self-contained interactive visual artifact is generated at [`plan.html`](plan.html).

## Red Team Review

### Session — 2026-08-30 (Ultra Mode: 5 Parallel Hostile Reviewers)
**Findings:** 12 total (12 accepted, 0 rejected)
**Severity breakdown:** 6 Critical, 6 High, 0 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Installer re-run overwrites existing secret keyring | Critical | Accept | Phase 01 |
| 2 | Cloudflare Tunnel container routing to container loopback (Direct `ingress:3100` upstream applied) | High | Accept | Phase 01 |
| 3 | First deploy skips image build (`cloud-harness-deploy <SHA>` required) | Critical | Accept | Phase 01 |
| 4 | Enrollment token query missing ID PK, `<id>.<secret>` wire format, explicit `BEGIN/COMMIT` transaction, guarded `UPDATE` and concurrent replay test | High | Accept | Phase 02 |
| 5 | Public bootstrap token enrollment endpoint mixed with mTLS stream port | High | Accept | Phase 02 |
| 6 | Network partition causes split-brain execution (Watchdog fence at 30s, lease epoch reauthorization, 45s replacement deadline, and concurrent execution test applied) | Critical | Accept | Phase 02 |
| 7 | Read-only balance check before admission permits compute draining (Atomic reservation needed) | Critical | Accept | Phase 03 |
| 8 | Double-entry ledger needs atomic stored procedure `post_journal` and integer micro-USD scale | High | Accept | Phase 03 |
| 9 | Webhook deduplication must use composite key `(gateway, webhook_event_id)` | Critical | Accept | Phase 03 |
| 10 | Global `/tmp/firecracker.socket` prevents concurrent microVM execution (Per-VM jailer socket needed) | Critical | Accept | Phase 04 |
| 11 | Ext4 COW assumption invalid (Device Mapper `dm-thin` block quota exclusively applied) | High | Accept | Phase 04 |
| 12 | Memory snapshot encryption requires authenticated tags (AES-256-GCM + HMAC) | High | Accept | Phase 04 |

### Whole-Plan Consistency Sweep
- Zero unresolved contradictions across all 6 phase documents and `plan.html`.
- Reconciled environment file locations, dual-compose launch commands, root-only token ingestion, dedicated-tenant gating, and double-entry ledger primitives.
