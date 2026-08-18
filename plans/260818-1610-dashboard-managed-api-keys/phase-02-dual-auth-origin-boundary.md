---
phase: 2
title: "Dual-auth origin boundary and runner verification"
status: completed
priority: P1
effort: "1.5-2d"
dependencies: [1]
---

# Dual-auth origin boundary and runner verification

## Context links

- [Plan](./plan.md)
- [Access auth](../../apps/api/src/auth.ts)
- [JWT verifier](../../apps/api/src/access-jwt-verifier.ts)
- [API mount](../../apps/api/src/app.ts)
- [Runner client](../../apps/api/src/runner-client.ts)

## Overview

Mount dormant exact `/mcp-api-key`, requiring two independent credentials: exact verified gateway Access assertion, then a locally verified API key.

## Architecture and requirements

```text
api.harness.zuey.me/mcp -> Worker service token -> Access assertion
-> harness.zuey.me/mcp-api-key -> exact gateway verification
-> private runner key verification -> creator principal -> unchanged MCP handler
```

- Add `API_KEY_AUTH_ENABLED=false`, `API_KEY_GATEWAY_ACCESS_AUDIENCE`, and exact normalized gateway service-subject pin. Fail config unless complete and `cloudflare-access`; owner-bearer cannot enable it. The gateway audience must differ from the main Access application audience.
- Use a dedicated verifier configuration for the path-scoped gateway Access application. Reusing its issuer/JWKS is allowed; reusing the main audience is not.
- Reuse bounded Access JWT verification, then require service identity and exact subject. Reject humans, other services, spoofed headers, opaque OAuth bearer, and missing assertions. Normal `/mcp` explicitly rejects the reserved gateway subject as defense in depth.
- Verify the bearer only after gateway verification through one strict, bounded, service-authenticated runner RPC that never logs request body/Authorization. Authentication path responses never contain a raw key; the Dashboard create contract is the sole narrow exception.
- Build request-local MCP `AuthInfo` only from the runner result: creator external selector plus sanitized credential ID for limiting/telemetry.
- Apply global pre-auth caps and bounded per-credential limits. All invalid-key classes return one 401 shape.
- Mount exact `/mcp-api-key` only: no aliases, redirect, discovery, dashboard, or fallback. Match `/mcp` JSON/Streamable HTTP bounds.
- Reverify every request; no positive cache, so revoke/expiry denies the next request.

## Related files

- Modify config contracts/API config, API auth/app/request-security/runner-client, runner app/verification service, and focused tests.
- Modify `deploy/ingress-proxy.mjs`, exact host nginx route, and boundary tests to carry only `/mcp-api-key` to the API without publishing a service port.
- Update the environment template with variable names/placeholders only.

## Implementation steps

1. Test dormant default, partial config rejection, Access-only enablement, and exact path.
2. Add purpose-specific exact-gateway assertion middleware.
3. Add strict runner verification RPC with secret-free errors.
4. Add API-key middleware/limiter and a second existing MCP handler mount.
5. Add exact streaming proxy locations through credential-free ingress and host nginx; retain header pass-through needed for Access assertion and MCP without placing secrets in ingress.
6. Test both-credential truth table, gateway assertion rejection on `/mcp`, human/main-audience rejection on `/mcp-api-key`, spoofing, concurrency isolation, runner outage, timeout, revoke, expiry, and exact ingress routing.
7. Regression-test `/mcp`, dashboard, readiness, and owner-bearer.

## Success criteria

- [x] G1, G2, G5, G8, G9, G11 pass.
- [x] Neither credential alone initializes MCP.
- [x] Only the pinned gateway subject can present managed keys.
- [x] Runner exposes no hash; authentication/list/revoke APIs emit no raw key. Only the typed Dashboard create response reveals it once with `no-store`.

## Risks and rollback

Keep separate exact route chains and request-local identity. Rollback disables public route, sets feature false, confirms hidden route absent, then follows Phase 1.

## Unresolved questions

None.
