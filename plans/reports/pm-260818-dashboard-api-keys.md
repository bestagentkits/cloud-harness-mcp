# Dashboard-managed API keys plan sync

## Status

| Phase | Status | Evidence / remaining gate |
|---|---|---|
| 1. Contracts, registry, migration | Complete | Focused coverage; compiled rollback leaves schema version 1 with `api_keys` absent. |
| 2. Dual-auth origin | Complete | Exact subject/audience and two-credential boundary focused-tested. |
| 3. Dashboard lifecycle | Complete | One-time reveal, no-store, revoke, UI safety, and regression coverage pass. |
| 4. Worker gateway | Complete | Fixed route/header policy tested; dry-run lists `API_KEY_RATE_LIMITER` at 600 requests/60s. |
| 5. Security verification | In progress | Corrections: 45 tests pass. Full verify: lint/typecheck/build plus 46 files/264 tests pass. Compose gate passes. Hosted exact-head Docker/E2E CI pending. |
| 6. Deploy, rollback, docs | In progress | Code/docs/rollback procedure complete. PR/CI, Cloudflare Access app, Worker/domain/rate limit, canaries, and production enablement pending. |

## Review decision

- Final reviewer: GO for commit/PR; no Critical, Important, or Medium findings.
- G1–G12 supported by implementation and automated evidence. G13 remains open for exact-head hosted CI and owner-authorized live canaries.
- Local API/runner image build and Docker/E2E unavailable due latency/timeouts; not claimed as passing.
- No production deployment or customer enablement claimed.

## Next actions

1. Open PR and require exact-head hosted CI, including Docker/E2E.
2. Provision separate path-scoped Cloudflare Access app/policy and Worker secrets/rate-limit binding.
3. Deploy preview, then run sanitized dual-lane, revoke, direct-origin, audience-selection, and leak canaries before production enablement.

## Unresolved questions

None.
