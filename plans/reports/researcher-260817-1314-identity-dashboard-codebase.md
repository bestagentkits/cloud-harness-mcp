# Identity + dashboard codebase scout

Date: 2026-08-17
Issues: [#13](https://github.com/bestagentkits/cloud-harness-mcp/issues/13), [#18](https://github.com/bestagentkits/cloud-harness-mcp/issues/18)

## Recommended boundary

Use Cloudflare Access as OIDC/JWT issuer, with GitHub and Google configured as Access IdPs. Keep static bearer auth as explicit `single-owner` mode. Serve the authenticated dashboard + BFF from the existing API origin behind Access; keep `site/` as the current public, static, credential-free Cloudflare Pages artifact. Dashboard actions must translate to versioned runner operations, never call Docker, the worker, or GitHub directly.

This retains the core topology: credential-free ingress is the only loopback-published Compose service; API has no Docker/job mounts; runner alone owns Docker, GitHub App credentials, and any secret-provider credential. Cloudflare requires origin validation of `Cf-Access-Jwt-Assertion` signature, issuer, application audience, time claims, and rotating account JWKS. References: [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [application claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [GitHub IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/), [Google IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/).

## Exact extension points

- `apps/api/src/auth.ts#bearerAuth`: static bearer only; raw token enters MCP `AuthInfo`; every request becomes configured `OWNER_ID`. Replace with shared principal middleware supporting discriminated static/Access modes.
- `apps/api/src/app.ts#createApiApp`: `/mcp` is the only authenticated route. Add same middleware to `/dashboard` and `/dashboard/api/v1/*`; preserve public health routes.
- `apps/api/src/mcp-server.ts#createCloudHarnessServer`: tool callbacks must take principal from authenticated request context.
- `apps/api/src/runner-client.ts#RunnerClient.call`: line 13 hard-codes `config.ownerId`. Require an authenticated principal per call; never accept principal identity from browser JSON.
- `packages/contracts/src/config.ts#ApiConfigSchema` and `apps/api/src/config.ts#loadApiConfig`: add `single-owner | cloudflare-access` auth configuration, exact Access issuer/audience, dashboard origin, and provider settings.
- `packages/contracts/src/runner-api.ts#RunnerRequestSchema`: introduce a backward-compatible v2 principal envelope or a service-authenticated resolver contract; keep v1 legacy compatibility.
- `apps/runner/src/state-store.ts#StateStore`: workspaces already have `owner_id`; idempotency and active-workspace uniqueness are owner-scoped. Add transactional migrations and principal/dashboard tables only when required by retained #18 scope.
- `apps/runner/src/workspace-service.ts#requireWorkspace`: line 269 loads by ID, then line 271 checks owner. Change to owner-qualified lookup.
- `apps/runner/src/security.ts#assertOwner`: returns 403 for an existing foreign handle, while an unknown handle returns 404. This currently leaks resource existence and violates #13.
- `apps/runner/src/github-app-broker.ts#mintRepositoryToken`: keep this as runner-only credential boundary; extend installation selection by principal without exposing tokens.
- `packages/contracts/src/tool-schemas.ts`: reuse workspace/file/task/session/path/output/pagination/expected-SHA contracts in the BFF. File write/patch/delete already support optimistic SHA checks.
- `apps/runner/src/operation-manager.ts`: task/session status is workspace-scoped but in-memory and lost on restart; UI must label it current/volatile until #14.
- `site/` and `docs/cloudflare-pages.md`: explicitly static and forbidden from Functions/secrets. Do not silently turn marketing Pages into a trusted BFF.

## Verified gaps and risks

1. Cross-principal enumeration: known foreign workspace -> 403; unknown workspace -> 404. Return one generic 404 from `(workspace_id, principal_id)` queries, with no URL/output leakage.
2. `ownerId` is process config, not an authenticated request identity; changing ingress auth alone does not create isolation.
3. `requestLimits()` is a global process bucket, not per principal. Multi-principal mode needs bounded per-principal buckets plus eviction.
4. SQLite is fixed at schema version 1 with no migration mechanism. Identity/dashboard state requires transactional migration + legacy owner mapping.
5. No project, artifact, audit event, environment metadata, secret reference, or per-principal GitHub installation model exists. A workspace-list UI cannot honestly close #18.
6. Authorize with Access `sub`; email is display/audit only. Cloudflare documents that removal/re-add can change `sub`; treat that as a new principal unless an operator explicitly relinks it.
7. Validate JWT at origin even behind Access. Header presence alone is spoofable through any bypass route. Pin issuer/audience/algorithm; validate `exp`/`nbf`; reject empty/service-token subjects for browser SSO; refresh JWKS safely on rotation.
8. Access login is not automatically MCP-standard OAuth discovery. If #13 targets hosted ChatGPT/Claude connector OAuth, RFC 9728 metadata and a compatible authorization-server flow remain separate acceptance work.
9. Access cookie auth still requires same-origin routing, exact Origin checks, JSON-only mutations, required CSRF header/token, secure headers, and `no-store`. No MCP/runner/Cloudflare/GitHub credential may reach JS, storage, HTML, logs, or responses.
10. Cloudflare Secrets Store supports create/rotate/delete but is beta and Workers-scoped. It is not by itself a safe VPS runner-to-executor secret delivery design.
11. Principal scoping does not create a hostile multi-tenant executor boundary. Preserve the private/trusted-operator warning unless execution isolation changes separately.

## Realistic TDD phase split

### Phase 1 — close #13 identity core

Tests first:

- `packages/contracts/test/contracts.test.ts`: legacy config remains valid; Access mode rejects missing/non-HTTPS issuer, audience, invalid origins, mixed modes.
- New `apps/api/test/access-auth.test.ts`: ephemeral RS256 JWKS; accept valid user token; reject wrong `iss`/`aud`, expired/early token, malformed JWT, empty `sub`, disallowed type, unknown `kid`; prove refresh/rotation; identical sanitized failures.
- Extend `apps/api/test/http-security.test.ts`: auth before rate limit, per-principal rate isolation, foreign Origin, no raw JWT/bearer in body or headers.
- Extend `apps/runner/test/state-store.test.ts`: v1->v2 migration, stable opaque principal for unique `(issuer, subject)`, legacy owner mapping, restart stability.
- New `apps/runner/test/principal-isolation.test.ts`: principal A cannot list/status/close/read/write/use task/session handles of B; existing-foreign and unknown handles return identical 404 envelopes.
- Extend `test/integration/mcp-http.test.ts`: both static single-owner and Access principal MCP requests reach runner with correct principal; no request field can override it.

Implementation:

- Define `Principal { id, kind, issuer, subject, displayEmail? }`; persist opaque ID, authorize by ID/issuer/subject, never email.
- Version API->runner request or add internal principal resolution. Runner service bearer remains independent.
- Make MCP and dashboard share the same resolver. Preserve static bearer mode and legacy records.
- Owner-qualify workspace lookup and key rate/idempotency/admission state by principal.

Gate: focused tests -> `npm run verify`; if topology changes, also `npm run verify:compose`.

### Phase 2 — dashboard read/control slice

Tests first:

- New `apps/api/test/dashboard-api.test.ts`: authenticated bootstrap/snapshot; workspace list/status; task/session list/status; bounded file list/read/write/patch/delete/move/mkdir; close; exact runner operation mapping; pagination/output bounds.
- New `apps/api/test/dashboard-csrf.test.ts`: reject missing/foreign Origin, missing/mismatched CSRF header, non-JSON mutation, stale SHA/ETag, oversized body, unauthenticated API; assert no secrets in response/cache/storage surfaces.
- UI tests for loading/empty/error states, keyboard navigation, labels, focus, destructive confirmation, and redacted secret rows.

Implementation:

- Same-origin `/dashboard/api/v1/*` BFF passes only request-derived principal to `RunnerClient` and reuses existing Zod tool schemas.
- Expose workspaces, repository URL/ref, lifecycle/limits, current task/session summaries, bounded files, and close. Do not expose shell/terminal or invent another executor path.
- Serve accessible dashboard assets from `/dashboard`; do not mutate public `site/` authority.

This phase is useful but does not close full #18.

### Phase 3 — retain full #18 scope, then close

Tests first:

- Runner state tests for principal-qualified environments, variable metadata, secret references, GitHub installation metadata, bounded audit events, migrations, retention, and compare-and-swap generations.
- Provider leak tests covering HTTP responses, logs, SQLite, checkout, executor env, helper stdin, and errors.
- GitHub callback tests for state/nonce, installation ownership, repository visibility, cross-principal denial, and no browser token persistence.
- Restart/TTL tests that distinguish durable metadata from volatile task/session data; artifact/history tests must coordinate with #14.

Implementation:

- Add owner-qualified tables with `generation`/timestamps; every mutation uses compare-and-swap and appends a redacted audit event.
- Add runner-only secret provider adapter for create/rotate/delete. SQLite stores reference metadata only; reads return configured/version/timestamps, never values. Provider credentials remain runner-only and are explicitly cleared from API/ingress/executor.
- Add GitHub App install/connect/callback/status BFF. Private key and minted tokens remain in runner; installation metadata is principal-bound.
- Audit summaries come from bounded audit records, not raw command output. Durable artifacts/project history require #14 or remain explicitly unavailable.

Gate: focused tests -> `npm run verify`; credential/Docker changes also image build, `npm run test:docker`, `npm run test:e2e` when available. Update security, architecture, configuration, MCP, deployment/operations, operator configuration template, Compose secret-clearing checks, and README connection guidance.

## Closure assessment

#13 can close after Phase 1 plus deployment documentation and cross-principal evidence. #18 cannot honestly close after Phase 2 because its issue text requires secret lifecycle, GitHub authorization management, auditability, optimistic concurrency, artifacts, and project/environment state. Complete Phase 3, or narrow/split #18 and leave the remainder open. #14/#15 dependencies mean durable artifacts and context presentation are unavailable today; do not relabel volatile state as durable.

## Unresolved questions

- Does #13 require MCP-standard OAuth discovery/authorization-server interoperability for hosted clients, or only verified Cloudflare Access OIDC/JWT principals at origin?
- Which custom hostname will Access protect, and will the current public `sslip.io` route be removed/restricted so it cannot bypass Access?
- Must #18 close with its full secret/GitHub/audit/artifact scope now, or may it be split after the authenticated workspace dashboard slice?
- Which secret backend is approved, and are secret values ever injected into executors?
- Should GitHub and Google sign-ins resolving to the same verified Access identity be one principal, or require explicit operator linking?
