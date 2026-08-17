---
phase: 4
title: "Tenant isolation and scale readiness"
status: pending
priority: P1
effort: "3-6d discovery; implementation separately approved"
dependencies: [2, 3]
---

# Phase 4: Tenant Isolation and Scale Readiness

## Overview

Make a conscious go/no-go decision before converting the private harness into
a shared service. This phase produces an evidence-based isolation design and
must not silently weaken the current deployment.

## Requirements

- [ ] Re-state the target tenants, adversary, acceptable blast radius,
  repository trust level, data residency, and availability objective.
- [ ] Compare rootless Docker, gVisor on a separate execution host, and
  microVM-class isolation against those requirements, including image build,
  storage quota, network, observability, and incident recovery costs.
- [ ] Design per-principal authorization, hard disk quota, concurrency rate
  limits, abuse controls, and per-tenant repository/cache separation.
- [ ] Produce a migration/rollback plan that keeps current single-owner VPS
  service operational while the new execution plane is validated.

## Related Code Files

- Read first: `docs/security-model.md`, `docs/system-architecture.md`, `apps/runner/src/workspace-service.ts`, `compose*.yaml`.
- Likely create or modify only after approval: a separate executor-host
  deployment, scheduler, quota storage integration, and policy test suite.

## Implementation Steps

1. Hold the threat-model and product-scope decision with the owner.
2. Benchmark/prototype the shortlisted isolation boundary using representative
   untrusted repositories and adversarial network/filesystem tests.
3. Cost the operational model and document SLOs, capacity limits, alerts, and
   incident containment.
4. Publish an ADR with go/no-go criteria. Create a new implementation plan
   only if the criteria and budget are accepted.

## Todo

- [ ] Threat model and candidate boundary evaluated.
- [ ] Migration/rollback and operational cost recorded.
- [ ] Go/no-go decision approved.

## Success Criteria

- [ ] No claim of multi-tenant safety is made without a verified execution,
  storage, network, and identity boundary.
- [ ] The current private-MVP security model remains unchanged until an
  approved migration is complete.

## Risk Assessment

This is a product and infrastructure fork, not an incremental Docker flag.
Treat an unapproved shared-user launch as blocked.
