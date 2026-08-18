---
phase: 3
title: "Dashboard API-key lifecycle and one-time reveal"
status: completed
priority: P1
effort: "1-1.5d"
dependencies: [1, 2]
---

# Dashboard API-key lifecycle and one-time reveal

## Context links

- [Plan](./plan.md)
- [Dashboard router](../../apps/api/src/dashboard-router.ts)
- [Control routes](../../apps/api/src/dashboard-control-router.ts)
- [Dashboard API client](../../apps/api/dashboard/dashboard-api.js)
- [Dashboard renderer](../../apps/api/dashboard/dashboard-render.js)

## Overview

Add create/list/revoke to the Access-authenticated, CSRF-protected dashboard BFF. Reveal plaintext once in transient UI with an explicit full-RCE warning.

## User flow and requirements

1. GitHub/Google user opens **API keys**. List shows name, safe prefix, state, created, expiry, last-used, revoked; never hash/plaintext.
2. Create requires name and integer expiry `1..365` days. Warn before submission that the key grants full MCP access, including arbitrary command execution as that principal.
3. Success displays secret once in a keyboard/focus-safe panel with copy and acknowledgement. Keep it only in current JS memory/DOM; clear on dismiss, navigation, page hide, or failed copy.
4. Revoke requires destructive confirmation and expected generation. No recovery, bulk export, scopes, or rotation action.

## API and security contract

- Add `GET /dashboard/api/v1/api-keys`, `POST /dashboard/api/v1/api-keys`, and generation-fenced `DELETE /dashboard/api/v1/api-keys/:keyId` behind existing Access principal, host/origin, JSON, CSRF, CSP, body-limit, and `no-store` controls.
- Runner derives `principal_id`; browser/API never chooses it. Foreign and missing resources are indistinguishable.
- BFF allowlists exactly one `apiKey` field on the typed successful create response. It is `no-store`; every other response and errors/accessibility announcements exclude the raw key.
- Display only the public Worker URL after readiness says enabled; never show hidden origin path or gateway credentials.

## Related files

- Modify API dashboard control/response/types modules.
- Modify dashboard API/render/app/style/HTML assets using current patterns.
- Modify runner dashboard control/internal schemas from Phase 1.
- Test router, UI contract/behavior, headers, DOM/storage leak, accessibility, and narrow viewport.

## Implementation steps

1. Write BFF tests for scoping, CSRF, validation, one-time create, redacted list, CAS revoke, and disabled state.
2. Add focused API-client/renderer behavior; modularize only at real current boundaries.
3. Add accessible create/revoke dialogs, copy feedback, expiry validation, active-count, and loading/empty/error states.
4. Clear secret on every exit path and never re-fetch/replay it; document the single trusted runner→API→browser response path.
5. Add static/runtime scans for storage, URL, analytics, console, and forbidden response fields.

## Success criteria

- [x] G4–G7 and G10 pass through BFF/runner/UI tests.
- [x] Keyboard-only create, copy-once, acknowledgement, and revoke work.
- [x] Warning states full authority, expiry, and non-recoverability.
- [x] Reload/list cannot reveal a prior secret.

## Risks and rollback

Lost create responses require a new key; never persist/replay plaintext. Feature readiness may hide this panel while the rest of dashboard stays available.

## Unresolved questions

None.
