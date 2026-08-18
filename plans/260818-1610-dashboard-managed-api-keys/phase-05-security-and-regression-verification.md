---
phase: 5
title: "Security, regression, and leak verification"
status: in_progress
priority: P1
effort: "1d"
dependencies: [1, 2, 3, 4]
---

# Security, regression, and leak verification

## Context links

- [Acceptance gates](./plan.md#observable-acceptance-gates)
- [Development verification](../../docs/development.md)
- [Security model](../../docs/security-model.md)
- [MCP contract](../../docs/mcp-api.md)

## Overview

Prove G1–G13 across contracts, API, runner, dashboard, Worker, migration, and unchanged OAuth/owner-bearer behavior before rollout.

## Verification matrix

- **Crypto/storage:** entropy/format, hash-only persistence, collision, final constant-time compare, reveal once, no recovery.
- **Authorization:** gateway+key truth table; gateway subject on `/mcp`; human/main-audience/other assertion on `/mcp-api-key`; malformed/oversized/unknown/foreign/revoked/expired key; cross-principal handle; next-request revoke.
- **Gateway:** forbidden duplicate/mixed-case headers, hop-by-hop/smuggling, arbitrary target, redirect, method/path, POST/GET/DELETE streaming, SSE/session/event, cache.
- **Lifecycle:** expiry clock edges, 10-key race, repeat/stale revoke, transaction failure, last-used races.
- **Browser:** CSRF/origin/type, `no-store`, DOM/storage/URL/console/error/a11y, reload after reveal.
- **Migration:** empty/existing v1 upgrade, failure, v2 restart, future version, quiesced down migration, prior binary, backup restore.
- **Regression:** Managed OAuth discovery/login/token, `/mcp` initialize/tools/call, dashboard SSO, owner-bearer, runner service auth, direct-origin denial, public tool snapshot.
- **Leaks:** source/diff/build assets, SQLite, API/Worker logs, audits, HTTP, snapshots, deploy receipts.

## Related gates

- Add focused tests beside modules and integration coverage under `test/integration/`.
- Run narrow suites, `npm run verify:compose`, `npm run verify`.
- When available, build executor/API/runner images and run Docker/e2e suites.
- Mandatory tester/debugger resolve failures; code-reviewer checks G1–G13, all callers, side effects, and public boundaries.

## Implementation steps

1. Maintain G1–G13-to-test receipt; only Phase 6 live gates may lack local runtime evidence.
2. Run contract/runner, API/MCP, dashboard, Worker suites in dependency order.
3. Run sentinel and secret-pattern leak tests on every storage/output surface.
4. Run full gates without weakening assertions, timeouts, or isolation.
5. Resolve findings, then independent code review of exact diff.

## Success criteria

- [x] Every G1–G13 row has passing automated evidence or named Phase 6 canary.
- [x] Compose/full verify pass on the reviewed working tree.
- [ ] Docker/e2e pass at exact head in hosted CI; local API/runner image builds and Docker/E2E were unavailable due latency/timeouts.
- [x] Public MCP/OAuth behavior remains compatible in automated regression coverage.

## Risks and rollback

No rollout with untested dual auth, leaks, migration uncertainty, or OAuth regression. Revert/re-plan instead of adding bypasses or weaker assertions.

## Unresolved questions

None.
