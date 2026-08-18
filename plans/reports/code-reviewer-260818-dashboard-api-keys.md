# Dashboard-managed API keys final review

## Verdict

**GO for commit/PR.** No remaining Critical, Important, or real Medium finding. Exact-head hosted CI remains a merge gate; live Cloudflare canaries remain an enablement gate.

## Resolved findings

1. **Usage telemetry is non-authoritative.**
   - Verified by `apps/runner/src/api-key-store.ts:125-140` and `apps/runner/test/api-key-store.test.ts:118-127`: the coalesced update is best-effort after the digest decision, and a trigger-forced telemetry failure still returns the verified principal/key ID without changing `last_used_at`.

2. **Cloudflare edge rate limiting has executable and operational ownership.**
   - Verified by `apps/api-key-gateway/wrangler.jsonc:12-20`, `apps/api-key-gateway/src/gateway.ts:94-103`, and `apps/api-key-gateway/test/gateway.test.ts:150-171`: the manifest owns a 600-request/60-second binding, exhaustion returns bounded `429` plus `Retry-After`, binding failure returns `503`, and neither path reaches origin. Configuration, security, and deployment docs own verification and rollback guidance.

## Acceptance trace

- G1-G3: code path separation, dedicated audience/exact service subject, normal `/mcp` rejection, fixed upstream, redirect rejection, header reconstruction, and Worker-owned service-token injection are present and focused-tested.
- G4-G9: 256-bit secret generation, strict format, SHA-256-only persistence, indexed ID lookup plus constant-time digest compare, principal binding/relink, transactional ten-active cap, revoke/expiry/no-positive-cache behavior, and non-authoritative coalesced usage telemetry are present.
- G10: create/revoke audit is principal-scoped, redacted, and runs inside the key mutation transaction with immutable key ID/generation.
- G11-G12: public MCP operation schemas remain separate; config truth table, v1/v2 migration, restart, compiled downgrade, and unrelated-state preservation have automated evidence.
- G13: intentionally incomplete locally. Exact-head hosted CI and owner-authorized Cloudflare/DNS/Access/Worker/revoke/direct-origin/leak canaries remain mandatory before merge and enablement.
- Browser: the successful create response is `no-store` through dashboard middleware; plaintext is held only in the current response/local reveal state and cleared on acknowledgement, cancel, navigation, page hide, or copy failure.
- Runner RPC: service-token authenticated, bounded JSON transport; presented keys are excluded from `AuthInfo`, logs, audit, and non-create response schemas.

## Fresh verification

- Initial focused contracts/API/Worker/runner: 5 files, 54 tests passed.
- Re-review focused contracts/API/Worker/runner: 4 files, 45 tests passed.
- API, runner, and Worker typechecks passed; Worker build/Wrangler dry-run passed and listed `API_KEY_RATE_LIMITER (600 requests/60s)`.
- `git diff --check` passed.
- Prior exact-tree evidence: full `npm run verify` 258 tests and `verify:compose` passed; local API/runner Docker builds and Docker/E2E were unavailable due latency/timeouts, not passes.

## Unresolved questions

None.
