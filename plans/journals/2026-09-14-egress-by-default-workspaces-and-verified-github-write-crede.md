---
title: Egress-by-default workspaces and verified GitHub write credentials
date: 2026-09-14
summary: "How PR #197 flipped the workspace egress default, added dashboard settings, and replaced blind App-token minting with a credential that can actually satisfy brokered GitHub writes"
---

# Egress-by-default workspaces and verified GitHub write credentials

## Problem

Two field reports, one embarrassing shared cause.

1. Callers opening a workspace without a `networkProfile` got `networkMode was replaced by networkProfile` — a deprecation error for a field we had already retired but kept advertising.
2. Agents inside an opened workspace got GitHub's `403 Resource not accessible by integration` on writes, with raw stderr and no hint of which permission was missing.

The brutal truth: neither was a hard bug to write, and both had been sitting in the code long enough for users to hit them first. We shipped `network-none` as the runner default (`packages/contracts/src/config.ts:195`, consumed at `apps/runner/src/workspace-service.ts:764`), so `gh` and the GitHub API were simply unreachable from an executor, while the UI still offered a field the backend rejected.

## Root cause

- Egress: with no explicit `networkProfile`, `workspace_open` fell through to the static runner default `network-none`. There was nowhere to change that without editing `.env` and redeploying — no settings table, no dashboard surface.
- `networkMode`: declared in the public schema (`packages/contracts/src/tool-schemas.ts:279,285-291`), listed in `docs-site/reference/tools.md:40`, and still present in the dead open-workspace dialog (`apps/api/dashboard/index.html:105-109`).
- GitHub writes: `runBrokeredGitHubAction` (`apps/runner/src/workspace-service.ts:1806-1845`) minted an App installation token through `apps/runner/src/github-app-broker.ts:105-127` and **never inspected what GitHub actually granted it**. The operator `GH_TOKEN`/`GITHUB_TOKEN` fallback only ran when the mint *threw*; a token minted short of the required permission was used as-is. The `403` was already classified as `GITHUB_PERMISSION_MISSING` (`github-error-classifier.ts:47-56`) but the message was raw stderr. Worse, `computeWorkspaceCapabilities` (`workspace-service.ts:1056-1067`) claimed `issuesWrite`/`pullRequestsWrite` merely because `GITHUB_APP_INSTALLATION_ID` was set — advertising a capability no credential could perform.

## Four design forks, resolved by counsel

Advisory supervision (`--advice`) ran two `kongming` consultations before the gates. The forks it settled:

1. **Instance-wide, single-row persisted default** in the runner state DB, not a per-principal preference — network posture is instance policy and two principals must not get different postures for the same request.
2. **Dashboard-only internal operations** (`settings_get`, `settings_update`, `settings_network_check`) behind the existing principal and CSRF gates, rather than widening the public tool surface.
3. **Fail-closed egress**: the shipped and built-in default becomes `dependency-access`; an unattested host firewall fails the open with `DEPENDENCY_EGRESS_UNAVAILABLE`. Kongming accepted that availability risk — there is no silent fallback to `network-none`. Resolution order is explicit request > persisted instance setting > environment/built-in.
4. **Pre-execution credential selection**: mint, read back granted permissions, and prefer the operator fallback when the App cannot satisfy the action — never retry after a `403`, because the operation may already have side effects.

A second consultation corrected two Phase 3 premises: installation action permissions are three-state (`none`/`read`/`write`, never defaulted to `read`), and the per-action scope table must be exact rather than `pr_*`-family based.

## Plan-gate corrections

Claim verification checked 64 assertions against the working tree: 50 verified, **9 failed, 5 unverified**. Every failure was mechanical and corrected in place — `.vitepress/config.ts` is not `.mts`; `createDashboardAssetsRouter` has a path allowlist that must register `/settings`; `DashboardResponseOperation` needed the three settings members; `PALETTE_PAGE_COMMANDS` uses `{id, group, label, hint, href}`; Phase 2 Task 2.3 must also drop `dashboard-render.js:20`; the state-store symbol is `getPreferredWorkspace`; and Task 3.2 had to update the existing `permissionScope` assertions in `brokered-github-operations.test.ts`.

Red-team review returned **4 blockers**, all resolved in the plan: (1) the mint-failure decision table became explicit — grant denial reaches the fallback, other failures keep existing behaviour, with rejected-mint tests required; (2) dashboard transport was completed (assets allowlist, response-operation union, palette contract, reset handling, renderer); (3) an **unsound self-heal was removed** — an action token reports the *requested* level, so persisting it could downgrade a known `write` grant; (4) coverage now names the local capability producer, in-memory installation stores, both SQLite column paths, and Phase 4's dependency on Phase 2.

## Mid-flight course correction: the permission union

The plan carried a union of permission scopes for labelled pull requests. Checking GitHub's endpoint contract killed it: the comment and label endpoints accept *either* `Issues: write` **or** `Pull requests: write`, so a pull-request action is already satisfied by its own scope. Requesting both over-constrains the mint and can fail with `422` for an App that grants Pull requests but not Issues. **One scope per action family shipped** (`phase-03-github-authorization.md:71-74`). This is the one change that only surfaced by reading the contract instead of trusting our own assumption.

## Tried and reverted

- **Permission union** — reverted per above; it was over-constraining and unverifiable.
- **Legacy `networkMode` read fallback in `dashboard-render.js`** — removed. The API response allowlist never forwards that field, so the branch was dead code. Keeping a fallback for a value that can never arrive is how deprecations live forever.
- **Persisting permissions observed from a minted action token** — dropped before implementation. The token reports what we *asked for*, not what was granted; writing it back could downgrade a known `write` installation record. Convergence stays with installation verification only.

## Review findings and fixes

Independent review (`code-reviewer`, fresh context) returned 2 Critical / 1 Important / 2 Minor:

- **Critical** — the capability schema rejected the local backend payload. Fixed by reporting the default with `WorkspaceNetworkExposureSchema` (the sibling field's type) and adding a test that parses a real local capability response against `WorkspaceCapabilityResultSchema`.
- **Critical** — a fresh host still got `network-none`: `deploy/scripts/bootstrap-vps.sh` generated the old value. Fixed; an existing runtime file is never rewritten.
- **Important** — a Contents-write grant suppressed fallback-backed write advertisement. Fixed by removing the `contentsWrite` gate on fallback widening, with a test.
- **Minor** — remediation advice replayed a failed idempotency key; now tells operators to open with a fresh key after readiness is restored.

## Operational risk accepted

An instance whose host firewall is not provisioned **fails workspace opens closed** by design. Remediation is `deploy/scripts/setup-dependency-firewall.sh`, or resetting the default from Settings or `WORKSPACE_NETWORK_PROFILE`. Because the environment value outranks the built-in default, an upgraded deployment pinning `WORKSPACE_NETWORK_PROFILE=network-none` keeps its current posture until an operator changes it. Egress also makes any credential injected into an executor exfiltratable by repository-controlled code; the Settings page states this and `network-none` remains the per-workspace and per-instance opt-out.

## Verification evidence

- `npm run verify` — **exit 0**, 123 test files, 1016 tests passed; 2 files / 26 tests skipped (POSIX-only fixtures under `describe.skipIf(win32)`).
- `npm run verify:compose` — `compose-boundaries=pass`.
- `npm run docs:check` — no drift after regeneration; `npm run plugin:check` — `.agents` and `plugins` skill copies byte-identical.
- Dashboard round-trip in a real browser against shipped assets and a stubbed BFF: `/dashboard/settings` rendered the stored profile as "Set in this dashboard"; Save posted `{defaultNetworkProfile:"network-none"}`, Reset posted `{defaultNetworkProfile:null}` and re-rendered source "Runner default", Check egress posted to `/settings/network-check` and rendered "Not ready: host firewall is not attested". Every mutation carried `x-csrf-token` through `dashboard-api.js`.
- Attestation gate unchanged: `ensureProfileReady` runs before every executor start; an unattested `dependency-access` open returns 503 `DEPENDENCY_EGRESS_UNAVAILABLE`.

## Known coverage gap

The dashboard Settings wiring is verified only by the manual browser round-trip above. The new dashboard UI tests assert source strings rather than exercising the wiring, so a regression in the POST paths or the renderer would pass CI. This is recorded as a follow-up, not silently accepted: it needs an automated round-trip test against the BFF.

## Lesson

Two lessons, both the same shape. First, deprecating a field is not the same as removing it — the schema, the generated reference, and the dashboard markup all still advertised `networkMode`, and users trusted the surfaces over the error message. Second, we minted credentials and assumed the grant matched the request. The fix was not more retries; it was reading back what GitHub actually returned and reading the endpoint contract before over-constraining a scope union. Verify the authority, then act.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
