# Phase 4: Documentation

## Context Links
- Plan: `plans/260913-2200-dashboard-access-diagnostics/plan.md`
- Docs: `docs/troubleshooting.md`, `docs/deployment.md`, `docs-site/troubleshooting.md`
- Owners: `apps/api/src/access-diagnostic.ts`, `deploy/systemd/cloud-harness-mcp.service`

## Requirements
- `docs/troubleshooting.md` gains the dashboard rejection row (reason codes, checks, and the
  fact that the browser now receives a diagnostic page) and the unit-start row for a missing
  `cloud-harness-service-compose`.
- The existing dashboard `session_ended` row distinguishes a lost CSRF session from a
  rejected assertion.
- `docs/deployment.md` records the unit's wrapper-else-release-script fallback next to the
  deploy description.
- `docs-site/troubleshooting.md` mirrors the symptom for operators without duplicating env
  defaults or command inventories.
- No plan/report text leaks into evergreen guidance; no credentials, tokens, or identity
  claims appear.

## Tasks
1. Update the internal troubleshooting table.
2. Add the fallback paragraph to the deploy section of `docs/deployment.md`.
3. Add the operator entry to `docs-site/troubleshooting.md`.

## Verification
```bash
npm run docs:check
```
Success: the reference and link checks pass and every reason code named by
`apps/api/src/access-jwt-verifier.ts` is documented once.
