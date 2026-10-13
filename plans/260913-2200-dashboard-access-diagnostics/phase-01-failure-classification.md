# Phase 1: Failure Classification

## Context Links
- Plan: `plans/260913-2200-dashboard-access-diagnostics/plan.md`
- Code: `apps/api/src/access-jwt-verifier.ts`
- Tests: `apps/api/test/access-auth.test.ts`

## Requirements
- Export `AccessAssertionFailure` with exactly these members: `missing_assertion`,
  `malformed_assertion`, `unsupported_algorithm`, `invalid_signature`, `unknown_key`,
  `jwks_unavailable`, `wrong_issuer`, `wrong_audience`, `wrong_token_type`,
  `invalid_subject`, `invalid_lifetime`, `expired_assertion`, `inactive_assertion`.
- `AccessJwtVerificationError` carries `readonly reason` and keeps the message
  `Cloudflare Access assertion verification failed`.
- Every `fail()` call site passes a reason; the JWKS document path reports
  `jwks_unavailable`, an absent key id reports `unknown_key`, a fetch/timeout failure reports
  `jwks_unavailable`, and absent assertion text reports `missing_assertion`.
- No change to any success path, cache bound, or timeout.

## Tasks
1. Add the union type and the `reason` field to the error class.
2. Classify `decodeJsonSegment`, `readBoundedBody`, `verify`, `keyFor`, and `fetchKeys`.
3. Extend `apps/api/test/access-auth.test.ts` with a reason table over the existing rejection
   fixtures plus absent/malformed/mis-algorithm/unknown-key/mis-signed and unreachable-JWKS
   cases.

## Verification
```bash
npm run build -w @cloud-harness/contracts
npx vitest run apps/api/test/access-auth.test.ts
```
Success: every rejection case asserts its expected `reason`, and the existing message-based
assertions still pass.
