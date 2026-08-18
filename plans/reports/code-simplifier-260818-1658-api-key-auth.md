# API-key implementation simplification

## Scope reviewed

- API authentication middleware and runner client
- Runner API-key service/store
- API-key contracts
- Cloudflare Worker gateway

## Changes

- Centralized the reserved gateway-subject comparison used by normal Access auth and the API-key gateway auth path. This keeps the audience split and exact-subject invariant expressed once.
- Simplified generic runner JSON fallback handling to one callback shape, removing a union and unsafe function cast while preserving timeout/unavailable behavior.
- Folded Worker request-header size and singleton rules into one policy map, removing parallel allowlist metadata.
- Left store, service, and contract implementation unchanged: their current separation is small, explicit, and security-relevant. No file exceeds 200 lines.

## Verification

- `npm run typecheck -w @cloud-harness/api` — pass
- `npm run typecheck -w @cloud-harness/api-key-gateway` — pass
- Focused auth/gateway/store/contracts suite — 4 files, 35 tests pass
- `git diff --check` — pass

## Preserved invariants

- Normal `/mcp` rejects the reserved gateway service subject.
- API-key route requires the exact gateway service subject and a valid key.
- Raw keys are not copied into `AuthInfo`.
- Worker forwards only allowlisted headers and injects its own Access service credentials.
- No positive key-auth cache introduced.

## Unresolved questions

None.
