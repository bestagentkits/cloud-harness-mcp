# Phase 5: Verification

## Context Links
- Plan: `plans/260913-2200-dashboard-access-diagnostics/plan.md`
- Gate owner: `package.json`

## Requirements
- Run the Windows-appropriate repository baseline from `AGENTS.md`: `npm run lint`,
  `npm run typecheck`, `npm run test:unit`. POSIX-only shell fixtures stay Linux CI-owned.
- Smoke test the real API in `cloudflare-access` mode: a browser-style request without an
  assertion must return the diagnostic page, a JSON client must return
  `{"error":"authentication_failed"}`, and the log must name the reason without echoing the
  assertion.
- Record every command and its observed result in the PR body; do not claim live private-clone
  or production verification without owner-authorized evidence.

## Tasks
1. Run the baseline gates and capture the results.
2. Start the built API locally with a synthetic Access configuration and exercise the three
   request shapes.
3. Stop the process and remove any local artifacts created for the smoke test.

## Verification
```bash
npm run lint && npm run typecheck && npm run test:unit
curl -sS -H 'Host: localhost' -H 'Accept: text/html' http://127.0.0.1:3099/dashboard | grep 'Reason code'
curl -sS -H 'Host: localhost' -H 'Accept: application/json' http://127.0.0.1:3099/dashboard/api/v1/workspaces
```
Success: gates pass; the page names `missing_assertion`; the JSON client still receives the
compact body.
