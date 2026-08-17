---
phase: 4
title: "Deployment contract, verification, and rollout evidence"
status: in-progress
priority: P1
effort: "1-2d plus operator rollout"
dependencies: [1, 2, 3]
---

# Deployment contract, verification, and rollout evidence

## Overview

Wire optional Access mode without weakening topology, update owning docs, run repository gates, and define the owner-only live rollout/rollback evidence required after merge.

## Requirements

- Keep ingress as the only loopback-published service; Docker authority, mounts, GitHub App credentials, and the secret-encryption key remain runner-confined.
- Document separate auth modes, Access Managed OAuth, GitHub/Google IdPs, audience/hostname/JWKS, session/CSRF, revocation, and rollback.
- Add current protected-resource/OAuth discovery guidance without inventing provider endpoints.
- Treat Cloudflare/IdP provisioning, DNS, Access policy, secrets, and live login as explicit owner operations.
- Make canary verification auth-mode aware: bearer mode uses the current private tool canary; Access mode tests only through the public OAuth edge with owner-authorized credentials and never enables a hidden bearer bypass.
- Use expand/contract migrations with a quiesced cutover, compatibility window, and tested rollback-after-write reconciliation for DB, jobs, containers, artifacts, and keyring.

## Related code files

- Modify as required: Compose files, operator config template, deploy templates/scripts, CI workflow
- Update the smallest owning surfaces among README, security model, architecture, configuration, MCP API, deployment, operations, troubleshooting, and development docs
- Test Compose boundaries, API/runner/unit/integration/e2e/Docker suites, and build/release gates

## TDD and verification steps

1. Add config/Compose verification before wiring changes; prove no credential crosses to API/ingress/executor and no new host port appears.
2. Update executable configuration and only docs whose rationale/workflow changed.
3. Test failed migration, canary failure, rollback before/after a write, mixed schema versions, and DB/job/container/artifact/keyring reconciliation.
4. Run focused tests, `npm run verify:compose`, `npm run verify`, image builds, Docker tests, and e2e when prerequisites exist.
5. Review full diff for public-contract/security regressions and secret leakage.
6. After PR CI is green, run advisory review, merge, and watch exact merge-SHA CI. Do not run production verification without owner credentials/authorization.
7. Operator rollout: provision an allowlisted trusted-operator Access/Managed OAuth app with GitHub/Google IdPs, pin the legacy issuer/subject, quiesce writes, deploy canary, verify discovery/login/refresh/revocation/cross-principal denial, then promote or roll back.

## Success criteria

- [ ] Repository gates pass and security topology changes only at explicit auth/dashboard surfaces.
- [x] Docs separate implemented code, merged release, configured Cloudflare resources, and live rollout.
- [x] Sanitized client/IdP/refresh/revocation/rollback checklist exists.
- [x] No production/Access claim lacks current owner-authorized evidence.

## Risk and rollback

Current `sslip.io` may be ineligible. Code ships disabled by default until an eligible hostname exists. Rollback follows the tested compatibility matrix; never restore an old DB snapshot while leaving newer jobs/artifacts live. Client incompatibility triggers a separate Managed OAuth vs Workers OAuth Provider decision; never add a second issuer silently.
