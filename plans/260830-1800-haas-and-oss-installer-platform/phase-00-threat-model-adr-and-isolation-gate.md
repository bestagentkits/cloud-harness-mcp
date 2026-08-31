---
phase: 0
title: "Multi-Tenant Threat Model, ADR & Owner Go/No-Go Gate"
status: pending
priority: P1
effort: "4d"
dependencies: []
---

# Phase 00: Multi-Tenant Threat Model, ADR & Owner Go/No-Go Gate

## Overview
Perform the required architectural discovery, threat-model comparison, and risk-boundary formalization before any multi-tenant execution code is written. This phase directly executes the prerequisites outlined in `plans/260817-0848-2-cloud-harness-next-steps/phase-04-tenant-isolation-and-scale-readiness.md`, producing an evidence-backed Architectural Decision Record (ADR), benchmarking candidate isolation technologies (gVisor vs Firecracker vs Dedicated VMs), documenting cost/SLO budgets, and obtaining an explicit owner Go/No-Go decision before any pooled multi-tenant infrastructure is activated.

## Requirements
- **Functional:**
  - **Formal Threat-Model Definition:**
    - Explicitly define target tenant profiles, adversary capabilities (untrusted repository scripts, malicious LLM outputs, crypto-mining loops, lateral network reconnaissance).
    - Define acceptable blast radius: A breach of one workspace container/microVM MUST NOT compromise neighboring tenant data, host kernel, or control-plane credentials.
    - Define data residency, persistent snapshot encryption standards, and incident containment runbooks.
  - **Isolation Technology Comparison & Benchmark Prototype:**
    - Benchmark three candidate boundaries against representative coding agent workloads:
      1. *Rootless Docker with AppArmor/Seccomp* (Baseline for trusted single-owner).
      2. *Dedicated Provider VM per Tenant* (Enforced single-tenant isolation for Beta).
      3. *Firecracker MicroVM via KVM / Jailer* (Hardware-level microVM isolation for Pooled GA).
    - Measure: Cold-boot latency (ms), memory overhead per idle workspace (MB), I/O throughput on `npm install`/`git clone`, and jailer security escape resistance.
  - **Operational Cost, SLO & Capacity Model:**
    - Document SLO targets (99.9% uptime, < 500ms workspace allocation latency).
    - Calculate operational breakeven vs server density across Hetzner/OVH bare-metal lines.
  - **Architectural Decision Record (ADR):**
    - Publish `docs/adr/0001-multi-tenant-isolation-and-haas-ladder.md` formalizing the isolation ladder (Dedicated VM in Beta -> Fail-Closed Firecracker in GA).
- **Non-functional:**
  - Zero Risk to Current Deployment: The current single-owner production service remains strictly unchanged and isolated during Phase 00 discovery.
  - Gated Transition: Commercial pooled deployment is strictly blocked until the owner signs off on the published ADR.

## Related Code Files
- Create: `docs/adr/0001-multi-tenant-isolation-and-haas-ladder.md` (Formal isolation ADR)
- Create: `test/benchmarks/isolation-overhead.bench.ts` (Startup latency and memory density benchmarks)
- Read first: `docs/security-model.md`, `docs/system-architecture.md`, `plans/260817-0848-2-cloud-harness-next-steps/phase-04-tenant-isolation-and-scale-readiness.md`

## Implementation Steps
1. **Threat Model Formulation:**
   - Map trust boundaries across MCP Client -> Control Plane -> Node Agent -> MicroVM/Container -> Host Kernel.
   - Document explicit non-guarantees of shared-kernel Docker for mutually distrustful tenants.
2. **Benchmark Prototyping:**
   - Measure startup latency and RAM footprint of Firecracker rootfs vs Docker container on a test Linux KVM host.
   - Validate Device Mapper thin-provisioning (`dm-thin`) block I/O performance under heavy build workloads.
3. **Cost, SLO & Alerting Specification:**
   - Define alerts for rogue CPU usage, disk exhaustion, and unexpected network egress.
4. **Publish ADR & Owner Sign-Off:**
   - Submit `docs/adr/0001-multi-tenant-isolation-and-haas-ladder.md` for owner review.
   - Formally record the Go/No-Go decision for proceeding with Phase 02 (Dedicated Orchestration) and Phase 04 (Firecracker GA).

## Success Criteria
- [ ] Published `docs/adr/0001-multi-tenant-isolation-and-haas-ladder.md` detailing security boundaries, SLOs, and cost models.
- [ ] Benchmark data proving Firecracker microVM cold-boot latency < 200ms and memory overhead < 35MB per idle VM.
- [ ] Explicit Owner Go/No-Go decision approved and recorded in the ADR before multi-tenant work commences.
- [ ] Single-owner OSS installation pipeline (Phase 01) remains unblocked and independently executable.

## Risk Assessment
- **Risk:** Benchmarks show Firecracker storage I/O is too slow for large mono-repo `git clone` or `npm install`.
  - *Observable Signal:* I/O latency > 3x compared to native container bind mounts.
  - *Response:* Test Direct-IO vs buffer cache configurations; if necessary, adjust tenant pricing to accommodate dedicated NVMe partitions.
