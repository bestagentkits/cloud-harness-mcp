---
title: "Cloudflare OAuth principal model and dashboard"
description: "Opt-in Cloudflare Access Managed OAuth with GitHub/Google SSO and a principal-scoped dashboard."
status: completed
priority: P1
effort: "8-12d"
issue: 13
linkedIssues: [18]
branch: codex/feat/cloudflare-oauth-dashboard
tags: [oauth, oidc, cloudflare-access, dashboard, security]
blockedBy: []
blocks: []
created: 2026-08-17
---

# Cloudflare OAuth principal model and dashboard

## Outcome

Close #13 and #18 in one security-first delivery. Cloudflare Access Managed OAuth authenticates MCP clients and the dashboard through GitHub or Google; Cloud Harness resolves a stable `(issuer, subject)` principal and authorizes every resource before lookup. Existing private installs retain explicit `owner-bearer` mode.

## Constraints and non-goals

- Access handles login, OAuth discovery/token issuance, and coarse admission; Cloud Harness owns resource authorization.
- GitHub SSO is identity only. Runner-confined GitHub App credentials remain the repository authorization boundary.
- Auth modes are mutually exclusive per deployment; no endpoint accepts both token families ambiguously.
- Access admission is restricted to one owner or a named set of mutually trusted operators sharing one security domain. Principal isolation does not make the shared-kernel executor hostile multi-tenant safe.
- The dashboard is enabled only in `cloudflare-access` mode. `owner-bearer` keeps MCP compatibility without placing the execution bearer in a browser.
- Code/test completion does not claim live Access, IdP, hostname, client, or production rollout.
- Secret values are write-only and encrypted with a runner-held key; they are never returned. Only explicitly selected user-owned environment values may enter a new workspace; control-plane/provider credentials never do.

## Phases

| # | Phase | Dependency | Status |
|---|---|---|---|
| 1 | [Principal authentication and authorization core](./phase-01-principal-authentication-and-authorization-core.md) | — | Completed |
| 2 | [Dashboard BFF and accessible workspace UI](./phase-02-dashboard-bff-and-workspace-ui.md) | 1 | Completed |
| 3 | [Environment, secret, GitHub, artifact, and audit controls](./phase-03-environment-secret-github-artifact-audit.md) | 1, 2 | Completed |
| 4 | [Deployment contract, verification, and rollout evidence](./phase-04-deployment-verification-and-rollout.md) | 1, 2, 3 | Completed |

## Acceptance criteria

- [x] `owner-bearer` stays default; opt-in `cloudflare-access` validates issuer, audience, subject, time claims, token type, algorithm, and rotating JWKS.
- [x] Known foreign and unknown handles produce the same denial; principal A cannot access B's resources.
- [x] Dashboard same-origin BFF reuses bounded runner operations and exposes no privileged terminal or second executor path.
- [x] Browser responses/storage contain no MCP/runner token, Access assertion, raw secret, GitHub App credential, or provider token.
- [x] Mutations require CSRF protection, optimistic concurrency, audit events, and accessible confirmation/error states.
- [x] GitHub/Google use Access-normalized `(issuer, subject)` identity; email is display-only, and changed subjects require an audited operator relink.
- [x] Focused tests, `npm run verify`, and applicable Compose/Docker gates pass.

## Existing-plan relationship

Executes the identity slice of `plans/260817-0848-2-cloud-harness-next-steps/phase-02-identity-egress-and-audit-controls.md`. It does not implement #12 egress isolation or claim tenant-readiness.

## Evidence and assumptions

- Research: `../reports/researcher-260817-1314-cloudflare-sso-architecture.md`; `../reports/researcher-260817-1314-identity-dashboard-codebase.md`.
- Managed OAuth is the initial standards path; Workers OAuth Provider is a fallback only if live compatibility fails.
- An eligible Cloudflare hostname/Zero Trust account is an operator prerequisite, not a hard-coded value.
- Full #18 scope ships: project/environment metadata, secret lifecycle, GitHub installation status, artifact/current-state summaries, and audit summaries.

## Red Team Review

### Session — 2026-08-17

**Findings:** 13 deduplicated (13 accepted, 0 rejected); 4 Critical, 8 High, 1 Medium.

| Risk | Accepted contract |
|---|---|
| Shared-kernel multi-principal execution | Access allowlist permits mutually trusted operators only; hostile multi-tenancy remains blocked on stronger isolation. |
| Managed OAuth credential ambiguity | Origin ignores opaque client bearer for identity and verifies only the forwarded Access assertion through a request-local seam. |
| JWKS unknown-key DoS | Pre-auth global caps, single-flight refresh, cooldown, fetch bounds, negative cache, and bounded stale-key behavior. |
| Legacy owner takeover/lockout | Operator pins the exact Access issuer/subject; startup aborts on ambiguous legacy rows; no first-login/email claim. |
| Internal operations leaking into MCP | Split public MCP operations from versioned internal dashboard runner operations and test `tools/list`. |
| GitHub metadata without authorization | Principal-bound one-time setup state, callback validation, server-side installation/repository verification, reconciliation/revocation. |
| Migration and rollback loss | Expand/contract schema, quiesced cutover, backup/restore and post-cutover-write matrix. |
| Secret key rotation outage | Versioned decrypt keyring, AEAD associated data, re-encryption and backup/restore ordering. |
| Bearer-mode dashboard contradiction | Dashboard disabled in bearer mode; Access mode owns browser authentication. |
| Access identity semantics | Accept Access-normalized identity; add subject-change recovery and live same-email tests. |
| Unowned secret/artifact catalogs | Define explicit environment-secret consumption and bounded artifact snapshot lifecycle in Phase 3. |
| Stale workspace close | Add internal generation-fenced close operation for dashboard use. |
| Access-mode deploy canary | Auth-mode-aware canary; no hidden bearer bypass. |

### Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all four phase files.
- Decision deltas checked: 13.
- Reconciled stale references: auth modes, identity linking, public/internal operations, migration, key rotation, GitHub flow, artifact/secret ownership, canary.
- Unresolved contradictions: 0.

## Validation Log

### Verification Results

- Tier: Standard; claims checked: 40.
- Verified: 40; Failed: 0; Unverified: 0.
- Evidence includes current auth middleware, request limiter, runner client/request schema, state store, workspace ownership check, GitHub broker, deploy scripts, and Docker boundary docs/tests.

### Confirmed decisions

- Cloudflare Access Managed OAuth is opt-in and required for dashboard use; bearer-only deployments retain MCP only.
- Access policies admit mutually trusted operators, not hostile tenants.
- Access-normalized subjects are canonical; operator-approved relink handles subject rotation.
- Full #18 includes real GitHub App binding, environment-secret consumption, bounded artifact snapshots, and audits.
- Cloudflare provisioning/live client proof remains an external rollout gate after merge.

### Phase 3 remediation evidence

- Independent re-review: `reports/code-review-phase3-remediation.md` — GO.
- Focused remediation receipt: 42 tests passed; workspace typecheck passed.
- Live rollout completed on `harness.zuey.me`: GitHub and Google SSO reach the principal-scoped dashboard, Google resolves the pinned legacy principal, Managed OAuth discovery is live, the public service-token canary passes, and production runs the exact merge SHA verified by CI.

### Whole-Plan Consistency Sweep

- Files reread: all plan and phase files.
- Unresolved contradictions: 0.

<!-- slug: 13-cloudflare-oauth-dashboard -->
