---
phase: 1
title: "Private MVP operational closure"
status: pending
priority: P1
effort: "2-3d"
dependencies: []
---

# Phase 1: Private MVP operational closure

## Overview

Turn the already-deployed private MVP into an auditable baseline before adding
new authority or durable state. This phase keeps the single-owner threat model
unchanged.

## Requirements

- [ ] Re-run repository-local quality and Compose-boundary gates from the
  current checkout; report pre-existing failures without weakening a gate.
- [ ] Add structured, redacted lifecycle audit events for workspace creation,
  close/expiry, runner recovery, brokered clone attempts, and policy denials.
- [ ] Define health, cleanup, storage-reserve, and executor-failure metrics
  with a documented operator inspection path; do not emit command content or
  credentials into telemetry.
- [ ] With explicit owner authorization and sanitized evidence, execute the
  optional real GitHub App private-clone verification. Otherwise retain it as
  a documented unverified capability.

## Related Code Files

- Modify: `apps/runner/src/workspace-service.ts`, `apps/runner/src/github-app-broker.ts`, `apps/api/src/app.ts`, `docs/operations.md`, `docs/security-model.md`.
- Test: `apps/runner/test/github-app-*.test.ts`, `test/integration/docker-sandbox.docker.test.ts`.

## Implementation Steps

1. Establish the current test and production-verification baseline without
   printing any sensitive runtime values.
2. Define a bounded audit-event schema with workspace IDs, owner pseudonym or
   opaque subject, action, outcome, reason code, and timestamps.
3. Emit events only in the trusted API/runner path; redact repository URLs as
   necessary and never log command input, tokens, or cloned Git config.
4. Add alertable health/cleanup/storage measurements and update the operations
   guide with their expected remediation path.
5. Perform the optional private-clone live check only when the owner supplies
   the necessary credentials and approves that operation.

## Todo

- [ ] Audit-event contract and retention decision recorded.
- [ ] Failure-path and redaction tests added.
- [ ] Operational documentation updated from executable evidence.

## Success Criteria

- [ ] A failed clone, expiry cleanup, and runner recovery are diagnosable from
  redacted trusted-plane evidence.
- [ ] Current quality and Docker gates pass, or any unrelated failure is
  reported with evidence.
- [ ] The private-clone verification state is accurate and no secret reaches
  source control, executor, logs, or this plan.

## Risk Assessment

Audit logs become another sensitive data sink. Keep a fixed event schema and
bounded retention; do not add raw command or environment capture.
