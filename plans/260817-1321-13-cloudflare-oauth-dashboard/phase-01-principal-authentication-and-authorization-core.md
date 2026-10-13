---
phase: 1
title: "Principal authentication and authorization core"
status: completed
priority: P1
effort: "2-3d"
dependencies: []
---

# Principal authentication and authorization core

## Overview

Introduce explicit auth modes, verify Access assertions, derive a durable principal, and make every runner lookup principal-scoped without changing public tool input schemas.

## Requirements

- Preserve constant-time `owner-bearer` authentication.
- Add `cloudflare-access` configuration with HTTPS issuer, audience, JWKS rotation, RS256, `iss`, `aud`, `sub`, `exp`, `nbf`, and `type=app` checks.
- In Access mode, treat the client bearer as opaque and derive identity only from the cryptographically verified `Cf-Access-Jwt-Assertion`; never trust a caller-supplied principal header/body.
- Persist opaque principal IDs keyed by `(issuer, subject)`; email/name are mutable display metadata.
- Require an operator-pinned legacy mapping from exact `OWNER_ID` to exact Access issuer/subject; abort startup on ambiguous unmapped legacy rows.
- Pass request-derived principal to every runner call; never accept it from tool/browser input.
- Make missing and foreign handles indistinguishable; rate-limit per principal with bounded eviction.
- Keep a small global pre-auth cap; make unknown-key JWKS refresh single-flight with cooldown, fetch bounds, negative caching, and bounded cached-key staleness.
- Add transactional SQLite migration and legacy owner mapping.

## Architecture

`Access/Managed OAuth -> API assertion verifier -> request-local ExternalPrincipal -> service-authenticated runner resolution -> opaque Principal -> owner-qualified query`. Runner resolves `(issuer, subject)` transactionally; the API never invents or accepts an opaque principal ID. One configured auth mode owns `/mcp`; dashboard routes exist only in Access mode.

## Related code files

- Modify: `packages/contracts/src/config.ts`, `packages/contracts/src/runner-api.ts`, `packages/contracts/src/index.ts`
- Modify: `apps/api/src/auth.ts`, `config.ts`, `app.ts`, `mcp-server.ts`, `runner-client.ts`, `request-security.ts`
- Modify: `apps/runner/src/state-store.ts`, `workspace-service.ts`, `security.ts`
- Test: contracts, API security, runner state/isolation, and MCP HTTP integration suites

## TDD implementation steps

1. Add contract tests for mutually exclusive modes and fail-closed Access config.
2. Add ephemeral-RSA/JWKS tests: valid, wrong issuer/audience/type, expired/early, empty subject, malformed, unknown key, and rotation.
3. Add concurrent-request tests proving the SDK/request-local identity seam never cross-contaminates principals.
4. Add migration/restart/dry-run tests for stable IDs, operator-pinned legacy mapping, duplicate/failed claim, mode rollback, and active workspaces.
5. Add cross-principal tests for every opaque workspace/task/session handle, including equal missing/foreign envelopes.
6. Implement config/auth resolver, runner-side principal resolution, owner-qualified queries, two-layer limiting, and bounded JWKS refresh.
7. Run focused tests, then `npm run verify`.

## Success criteria

- [x] Both modes pass independently; mixed/partial config fails closed.
- [x] JWT/provider secrets do not appear in responses, logs, SQLite, or runner inputs beyond normalized principal identity.
- [x] Principal A cannot infer or use B's handles.
- [x] Bearer tests and public MCP tool schemas stay compatible.

## Risk and rollback

Remote JWKS outage must not become indefinite trust: accept only an explicitly bounded cached-key window. Use expand/contract migrations; quiesce mutations through cutover and define backup/restore plus post-cutover-write rollback. If the SDK cannot provide request auth safely, replan instead of adding global identity state.
