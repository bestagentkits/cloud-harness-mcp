---
phase: 6
title: "Deployment, rollback, and documentation"
status: complete
priority: P1
effort: "1-1.5d"
dependencies: [1, 2, 3, 4, 5]
---

# Deployment, rollback, and documentation

## Context links

- [Plan](./plan.md)
- [Deployment](../../docs/deployment.md)
- [Operations](../../docs/operations.md)
- [Configuration](../../docs/configuration.md)
- [Architecture](../../docs/system-architecture.md)
- [Client connection](../../README.md#connect-from-ai-clients)

## Overview

Roll out dormant-first in reversible stages, then prove both public lanes and a sanitized create/use/revoke lifecycle at the exact deployed commit.

## Deployment sequence

1. Record branch/SHA, CI, Cloudflare account/zone/application identifiers, DNS target, Access policies, origin config, DB version, and rollback artifact without credentials.
2. Quiesce, back up SQLite, deploy v2-capable code with feature disabled, migrate/restart/verify OAuth/dashboard, then resume.
3. Create a separate Access application scoped exactly to `harness.zuey.me/mcp-api-key`, with its own audience and an exact Service Auth policy for the dedicated Worker token. Do not add this token to the existing `/mcp`/dashboard application. Store values only as Worker secrets; pin normalized service subject and gateway audience in origin config.
4. Deploy preview, prove stripping/fixed upstream/direct-origin denial, then bind `api.harness.zuey.me/mcp` in the owned zone. No unproxied origin record.
5. Enable hidden route, create disposable short-lived key, initialize/list/call through Worker, revoke, prove next request fails, then destroy test state.
6. Re-run GitHub/Google dashboard login and Managed OAuth discovery/initialize on `harness.zuey.me/mcp`; prove gateway assertion is denied there, prove Cloudflare selects the path-scoped gateway app/audience only for the hidden path, verify exact head, and inspect logs/DB/audit/browser for key/hash absence.

## Rollback matrix

- **Worker:** disable public route; OAuth/dashboard unchanged.
- **Origin:** feature false, hidden route absent, then revoke Worker service token.
- **Application:** quiesce, backup v2, run tested v2→v1 (API keys invalidated, unrelated data retained), deploy prior images/config, canary OAuth/dashboard/readiness.
- **Corruption:** stop and restore coordinated pre-migration backup; report any unrelated post-cutover write loss.
- Never expose bearer-only nginx/origin, publish API/runner, relax Access, or retain temporary bypass.

## Documentation owners

- README and MCP usage: separate URLs, full-RCE warning, reveal/expiry/revoke.
- Security model: Worker/public bearer and exact service assertion boundaries.
- System architecture: Worker→Access→hidden origin→runner verification.
- Configuration and environment template: dormant variable/secret names, never values.
- Deployment, operations, troubleshooting: provision, canary, revoke, backup/down migration, 401/HTML/Worker diagnosis, replacement rotation.
- Point docs to executable schemas/scripts/manifests rather than copy generated inventories.

## Success criteria

- [x] G12/G13 receipts record exact SHA, CI, deployments, hosts, revoke, rollback readiness, and secret-free evidence.
- [x] OAuth, GitHub/Google dashboard, and static Bearer clients work only on intended lanes.
- [x] Direct origin, wrong assertion, and revoked key remain denied.
- [x] Docs state full authority, no scopes, no recovery, no rotation endpoint.

## Live rollout receipt

- Release `v0.7.1` deployed commit `c193dd09a8c8fcf1597ea620251dbcd61f51426e` after post-merge CI run `32147300865`; production run `32147597077` succeeded.
- `harness.zuey.me/mcp-api-key` is protected by the separate path-scoped Access application and exact Service Auth policy. Without the Worker assertion it returned 403; with the assertion and no key it reached the origin and returned JSON 401.
- `api.harness.zuey.me/mcp` returned bounded JSON failures for missing and malformed bearer values. A disposable one-day key initialized and listed 52 tools only through this Worker URL.
- The same key was rejected on the OAuth URL, then rejected by the Worker on the first request after dashboard revocation. The dashboard recorded last use and revocation, the database contained no plaintext match, and the clipboard was cleared.
- Production service readiness passed, nginx exposed the exact streaming route only to loopback origin, and `/etc/cloud-harness-mcp/runtime.env` remained root-owned mode 0600.

## Risks and rollback

Cloudflare state and code deployment are separate evidence. Preserve known-good OAuth throughout; stage new hostname last and remove its route first on rollback.

## Unresolved questions

None.
