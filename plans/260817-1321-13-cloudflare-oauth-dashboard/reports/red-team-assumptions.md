# Red-team assumption review

Date: 2026-08-17
Lens: Hostile Assumption Destroyer; fact/contract verification only

## Findings

### 1. Critical — `owner-bearer` cannot authenticate the promised browser dashboard without exposing the MCP bearer

- **Plan location:** `plan.md:20,26,44-45`; `phase-01-principal-authentication-and-authorization-core.md:27`; `phase-02-dashboard-bff-and-workspace-ui.md:18,47`.
- **Breakable assumption:** One mutually exclusive deployment auth mode can own both `/mcp` and dashboard routes, while `owner-bearer` remains supported and the browser never receives the bearer.
- **Concrete failure:** In `owner-bearer` mode, the only current user authenticator requires `Authorization: Bearer <MCP_BEARER_TOKEN>`. If the browser cannot receive that token and Access is not the configured mode, `/dashboard` has no login/session bootstrap. Either the single-owner dashboard is unusable or the MCP execution credential is exposed to browser JS/storage, violating acceptance.
- **Evidence:** `apps/api/src/auth.ts:14-24` accepts only the MCP bearer and places the raw token in request auth; `apps/api/src/app.ts:23-30` applies it only to `/mcp`; `docs/security-model.md:49-55` defines the bearer as the current public authentication boundary. The research itself only makes a bearer-mode dashboard viable by adding Access in front and holding the bearer server-side (`plans/reports/researcher-260817-1314-cloudflare-sso-architecture.md:61-65`), which contradicts mutually exclusive auth modes.
- **Fix:** Choose and document one explicit contract: (a) dashboard disabled in `owner-bearer`; (b) separate browser session authentication with server-held owner credential; or (c) Access protects dashboard while `/mcp` stays bearer on a separate hostname/audience. Add acceptance tests for the chosen single-owner flow and remove the impossible combined claim.

### 2. Critical — `(Access issuer, sub)` cannot enforce “no automatic cross-provider linking”

- **Plan location:** `plan.md:20,47`; `phase-01-principal-authentication-and-authorization-core.md:19-20`.
- **Breakable assumption:** GitHub and Google identities can be keyed by the Access assertion's `(iss, sub)` while remaining unlinked unless Cloud Harness explicitly links them.
- **Concrete failure:** Cloudflare documents Access `sub` as unique to an email address within the Zero Trust account, not as the upstream GitHub/Google subject. GitHub and Google logins that Access resolves to the same email can therefore arrive with the same `(iss, sub)` and are automatically the same Cloud Harness principal. Conversely, removing and re-adding a user changes `sub`, strands existing resources, and creates a new principal. The planned key cannot both prevent provider linking and provide durable identity continuity.
- **Evidence:** `plans/reports/researcher-260817-1314-cloudflare-sso-architecture.md:48-50` records the email-based account scope and remove/re-add change; the same report leaves desired GitHub/Google linking unresolved at `:155-156,169-170`. Current official Cloudflare claim semantics are linked there. No upstream provider identifier is required by the plan.
- **Fix:** Decide identity semantics before implementation. If Access-normalized identity is accepted, state that same-email provider logins may intentionally converge and add operator relink/recovery for changed `sub`. If provider separation is required, require a verified immutable upstream IdP identifier/claim and key by `(Access issuer, IdP id, upstream subject)`; do not claim `(iss, sub)` prevents linking.

### 3. Critical — no trusted request-to-principal resolution seam is defined

- **Plan location:** `phase-01-principal-authentication-and-authorization-core.md:14,20-21,27,31-42,54`; `phase-02-dashboard-bff-and-workspace-ui.md:26`.
- **Breakable assumption:** The API can validate an assertion, obtain the runner-persisted opaque principal ID, and pass it through every MCP tool callback by changing `RunnerClient.call`.
- **Concrete failure:** Authentication runs in Express request middleware, but the current MCP server factory closes only over a process-wide `RunnerClient`; each tool callback forwards only operation/input/signal. Separately, the persisted principal is supposed to live in runner SQLite, but the private runner contract has no principal-resolution operation. An implementation may fall back to global mutable identity, trust a browser/tool-supplied ID, derive a different ID in API memory, or add an unplanned round trip/cache — all of which break request isolation or restart stability.
- **Evidence:** `apps/api/src/app.ts:12-16,23-30` creates the handler without a request principal closure; `apps/api/src/mcp-server.ts:13-34` has no authenticated request identity in its server or callback contract; `apps/api/src/runner-client.ts:3-14` hard-codes `config.ownerId`; `packages/contracts/src/runner-api.ts:19-24` accepts only `{version, ownerId, operation, input}`; `apps/runner/src/state-store.ts:43-61` has schema v1 and no principal resolver.
- **Fix:** Make the trust seam an explicit design and test before the rest of Phase 1. For example, pass a verified request principal through a documented SDK-supported per-request context, then use a versioned service-authenticated runner request whose runner-side transaction resolves `(issuer, subject)` to opaque `principalId`. Prohibit caller-selected IDs, define caching/restart behavior, and prove two concurrent requests cannot cross-contaminate identity.

### 4. Critical — per-principal GitHub installation association has no authorization ceremony

- **Plan location:** `phase-03-environment-secret-github-artifact-audit.md:14,21,31,41,43,50`.
- **Breakable assumption:** Adding installation/repository metadata per principal is enough to “connect and manage” GitHub authorization safely.
- **Concrete failure:** Today the runner trusts one operator-configured installation ID and mints a token for any requested repository name visible to that installation. In a multi-principal dashboard, accepting an installation ID or repository association as ordinary metadata lets a principal claim another installation/repository unless there is a state-bound installation setup callback or explicit operator grant. Merely showing “status” does not establish ownership or authorization.
- **Evidence:** `packages/contracts/src/config.ts:33-37` configures exactly one global installation; `apps/runner/src/github-app-broker.ts:4-18` mints from that installation with no principal input; `apps/runner/src/workspace-service.ts:371-389` authorizes remote Git only from repository URL plus global broker config. The scout required callback state/nonce and installation ownership tests (`plans/reports/researcher-260817-1314-identity-dashboard-codebase.md:84-87,91-94`), but Phase 3 dropped that ceremony.
- **Fix:** Define the complete authorization flow: principal-bound one-time state, callback/setup handling, installation lookup using runner-held App credentials, repository permission verification, revocation/reconciliation, and operator recovery. Store only verified associations; never accept principal/installation ownership from dashboard JSON. Add cross-principal callback replay and claimed-installation tests.

### 5. High — the plan promises artifact and secret “configuration” without a runtime producer/consumer contract

- **Plan location:** `plan.md:29,37,44,59`; `phase-02-dashboard-bff-and-workspace-ui.md:14,19,36`; `phase-03-environment-secret-github-artifact-audit.md:14,18-22,26,30,38-55`.
- **Breakable assumption:** Dashboard-only metadata tables can truthfully complete artifacts, environment secrets, and current-state scope while the general task/artifact facade remains excluded and secrets are never injected or read.
- **Concrete failure:** Phase 2 tests an artifact/project summary before Phase 3 creates any metadata operation. Phase 3 can persist ciphertext and artifact rows, but no existing operation produces durable artifacts and no runtime consumes secret values. The UI can therefore present manually created/stale rows as configured environments or artifacts even though execution cannot use the secret and no artifact lifecycle owns the record. This does not close the issue's operational scope; it creates an unauthoritative parallel catalog.
- **Evidence:** `packages/contracts/src/runner-api.ts:4-16` has no project, environment, secret, artifact, or audit operation; `apps/runner/src/operation-manager.ts:28-38,285-318` retains only volatile in-memory task/session output; `docs/system-architecture.md:80-88` says those handles and outputs disappear on restart. The plan itself excludes #14's artifact facade (`phase-03-environment-secret-github-artifact-audit.md:53-55`), while the scout says durable artifacts/project history require #14 or must remain unavailable (`plans/reports/researcher-260817-1314-identity-dashboard-codebase.md:94-100`).
- **Fix:** Split truthful capabilities. Define environment/secret **reference metadata** and an explicit authorized consumer before calling it configuration; otherwise label it metadata-only and keep that issue scope open. Gate artifacts on #14 or define a concrete producer, lifecycle, retention, provenance, and reconciliation contract here. Reorder Phase 2 so it cannot test/read resources that Phase 3 has not introduced.

## Unresolved questions

- Is same-email GitHub/Google convergence through Cloudflare Access intended?
- Must the dashboard work when `/mcp` remains `owner-bearer`, and if so, what authenticates the browser?
- Who is authorized to bind a GitHub App installation to a principal: the authenticated user, the single operator, or both?
- Are secret records metadata-only, or which trusted runtime is expected to consume decrypted values?

**Status:** DONE
**Summary:** Five load-bearing plan assumptions fail against current Cloudflare identity semantics and repository contracts; three are authorization-boundary blockers.
**Concerns/Blockers:** Plan should not enter implementation until browser auth mode, identity semantics, request-principal propagation, and GitHub installation binding are decided.
