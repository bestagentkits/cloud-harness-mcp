---
phase: 2
title: "Identity, egress, and audit controls"
status: pending
priority: P1
effort: "4-6d"
dependencies: [1]
---

# Phase 2: Identity Egress and Audit Controls

## Overview

Replace the single bearer-only assumption only if the product needs more than
one principal, and make egress policy enforceable below the tool layer. This
phase is prerequisite work for credentialed collaboration and any future
shared-user offering.

## Requirements

- [ ] Write and approve the principal model: retain single-owner bearer for
  private operation, or adopt OAuth/OIDC with an issuer, audience, subject,
  expiry, and rotation policy.
- [ ] Bind workspace, repository, task, and later artifact records to a stable
  subject; opaque handles remain references, never bearer authorization.
- [ ] Replace the broad `bridge` option with explicitly named network profiles
  and a technical enforcement design that blocks loopback, control-plane,
  private, link-local, and metadata ranges.
- [ ] Ensure audit events record policy outcomes rather than request secrets.

## Related Code Files

- Modify: `apps/api/src/auth.ts`, `apps/api/src/request-security.ts`, `apps/api/src/app.ts`, `packages/contracts/src/config.ts`, `apps/runner/src/workspace-service.ts`, `compose*.yaml`.
- Test: `apps/api/test/http-security.test.ts`, `test/integration/docker-sandbox.docker.test.ts`, `scripts/verify-compose-boundaries.mjs`.

## Implementation Steps

1. Choose the identity mode through a threat-model review; do not add OAuth
   merely for cosmetic protocol completeness.
2. Version the internal owner/principal field before the public tool contract
   needs multi-user permissions.
3. Prototype the egress boundary outside the executor and verify it using
   real destination classes, not command-string filtering.
4. Make workspace creation choose only allowed profiles and surface the
   security consequence in the tool result and documentation.
5. Test request authentication, cross-owner handle denial, and blocked
   metadata/control-plane reachability.

## Todo

- [ ] Identity and egress decision accepted.
- [ ] Enforcement and negative-network tests added.
- [ ] Threat model and configuration docs revised.

## Success Criteria

- [ ] A principal cannot use another principal's handle.
- [ ] Enabling dependency access cannot reach local, metadata, Docker, or
  control-plane addresses.
- [ ] Single-owner deployments remain simple and compatible where OAuth is
  deliberately deferred.

## Risk Assessment

OAuth and a proxy can create substantial operational surface. Keep this phase
behind the product decision; a bearer token is acceptable only while the
single-owner scope stays true.
