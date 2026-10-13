---
title: "Dashboard-managed API keys through a Cloudflare Worker gateway"
description: "Add principal-bound static API keys without weakening Managed OAuth or origin Access."
status: complete
priority: P1
effort: "6-9d"
branch: codex/feat/dashboard-api-keys
tags: [api-keys, dashboard, cloudflare-worker, authentication, security]
created: 2026-08-18
---

# Dashboard-managed API keys

## Outcome

Dashboard users can create, list, and revoke expiring API keys for static MCP clients. OAuth clients remain on `https://harness.zuey.me/mcp`; API-key clients use `https://api.harness.zuey.me/mcp` through a dedicated Cloudflare Worker. The origin accepts keys only at exact `/mcp-api-key`, protected by a separate path-scoped Access application and audience, and only with the verified, exactly pinned Worker service assertion.

## Constraints and non-goals

- Preserve `cloudflare-access`, GitHub/Google SSO, Managed OAuth discovery, and public MCP tool schemas.
- Store only SHA-256 hashes of CSPRNG 256-bit secrets; reveal plaintext once, never in logs, audit, SQLite, analytics, or browser persistence.
- Bind each key to durable `principal_id`; every key grants that principal's full MCP/RCE authority.
- Mandatory expiry `1..365` days, maximum 10 active keys per principal, immediate next-request revoke.
- No scopes, ownership edits, recovery, bulk export, or rotation endpoint; rotate by create-new then revoke-old.
- Gateway and origin route are dormant by default; no direct-origin or spoofed-header fallback.

## Phases

| # | Phase | Dependency | Status |
|---|---|---|---|
| 1 | [Contracts, registry, migration](./phase-01-contracts-key-registry-and-migration.md) | — | Complete |
| 2 | [Dual-auth origin](./phase-02-dual-auth-origin-boundary.md) | 1 | Complete |
| 3 | [Dashboard lifecycle](./phase-03-dashboard-api-key-lifecycle.md) | 1, 2 | Complete |
| 4 | [Worker gateway](./phase-04-cloudflare-worker-gateway.md) | 2 | Complete |
| 5 | [Security verification](./phase-05-security-and-regression-verification.md) | 1–4 | Complete |
| 6 | [Deploy, rollback, docs](./phase-06-deployment-rollback-and-documentation.md) | 1–5 | Complete |

## Observable acceptance gates

- [x] G1 OAuth stays on `/mcp`; API keys use only the Worker hostname; hidden origin route is not advertised.
- [x] G2 Origin requires the separate gateway-app audience and exact configured gateway service subject before key verification; `/mcp` explicitly rejects that reserved subject.
- [x] G3 Worker reconstructs allowlisted requests; caller `Cf-*`, Access, `Forwarded`, and `X-Forwarded-*` cannot pass.
- [x] G4 Secrets have 256-bit entropy, reveal once, and persist only as SHA-256 plus safe metadata.
- [x] G5 Key lifecycle and resulting MCP authority remain bound to creator `principal_id`.
- [x] G6 Expiry `1..365` days and 10-active-key limit hold transactionally under concurrency.
- [x] G7 Plaintext and hash are absent from logs, audit, errors, browser storage, analytics, fixtures, and receipts.
- [x] G8 Revoked, expired, unknown, and malformed keys fail uniformly with no positive auth cache.
- [x] G9 `last_used_at` is coalesced and never participates in authorization.
- [x] G10 Create/revoke emit redacted principal-scoped audits using immutable key ID/generation.
- [x] G11 Public runner/tool schemas, `tools/list`, OAuth discovery, and owner-bearer installs stay compatible.
- [x] G12 v1→v2, restart, v2→v1 rollback, and dormant readiness preserve unrelated state.
- [x] G13 live canaries prove path-specific Access app selection, audience separation, both lanes, revoke, direct-origin denial, exact head, and zero secret retention.

## Evidence and decision record

- Scout authority: API auth/app, dashboard control modules, internal runner contract, runner metadata schema/store.
- Research: `../reports/researcher-260818-1610-api-key-auth-security.md`. Its native service-token recommendation is superseded because static clients need ordinary Bearer keys; Worker plus exact service assertion retains no-bypass origin security.
- Baseline: `../260817-1321-13-cloudflare-oauth-dashboard/`.
- Review: six phases swept against G1–G13; public MCP schemas remain untouched; rollback is explicit; unresolved decisions: none.
- Release receipt: PR #42 merged as `c193dd09a8c8fcf1597ea620251dbcd61f51426e`; post-merge CI run `32147300865`, release `v0.7.1`, and production deploy run `32147597077` completed successfully.
- Live receipt: exact `/mcp-api-key` Access selection returned 403 without a service assertion and JSON 401 with the pinned assertion but no API key. A one-day disposable key initialized through `https://api.harness.zuey.me/mcp`, listed 52 tools, was rejected on `https://harness.zuey.me/mcp`, and failed on the next request after revocation. The plaintext was absent from SQLite and the transient clipboard was cleared.

<!-- slug: dashboard-managed-api-keys -->
