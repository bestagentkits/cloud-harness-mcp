---
title: "Workspace network default and GitHub write authorization"
description: "Make opened workspaces egress-capable by default, add a dashboard Settings page that owns that default, and make brokered GitHub writes use a credential that can actually satisfy them."
status: completed
priority: P1
effort: "1-2d"
tags: [network, dashboard, github, security]
created: 2026-09-14
---

# Workspace network default and GitHub write authorization

## Overview

Three defects share one root: the harness decides workspace egress and GitHub
write authority from static configuration, while the operator's real intent
(GitHub operations must work inside a workspace) is expressed per instance.

1. `workspace_open` with no `networkProfile` resolves to the runner config default
   `network-none` (`packages/contracts/src/config.ts:195`,
   `apps/runner/src/workspace-service.ts:764`), so `gh` and the GitHub API are
   unreachable from an executor. The owner wants egress by default.
2. There is no place to change that default without editing `.env` and
   redeploying; the dashboard has no settings surface and the runner has no
   settings table.
3. `github_action` mints a GitHub App installation token whenever it can and never
   inspects what GitHub actually granted it
   (`apps/runner/src/workspace-service.ts:1806-1845`). The fallback already runs
   when the mint throws, but a token minted short of the required permission is
   used as-is, so `gh` receives GitHub's
   `403 Resource not accessible by integration`; the classified code is
   `GITHUB_PERMISSION_MISSING` (`github-error-classifier.ts:47-56`) while the
   message is raw stderr, naming neither the missing permission nor the fallback.
   A single-scope mint also cannot satisfy `gh pr create --label`, and the
   advertised `capabilities.repository.issuesWrite` is derived from "an App is
   configured", not from the granted permission
   (`apps/runner/src/workspace-service.ts:1056-1067`).

A fourth, smaller defect produces the second reported error: the retired
`networkMode` field is still advertised to agents — declared in the public
`workspace_open` schema (`packages/contracts/src/tool-schemas.ts:279,285-291`),
listed in the generated tool reference (`docs-site/reference/tools.md:40`), and
present in the dashboard's dead open-workspace dialog
(`apps/api/dashboard/index.html:105-109`) — so callers keep sending it and get
the deprecation rejection.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | A workspace always has GitHub-capable egress unless a caller or the operator explicitly narrows it | P1 |
| 2 | The operator changes that default from the dashboard, with egress readiness and the credential-exfiltration tradeoff visible | P1 |
| 3 | Brokered GitHub writes succeed whenever any configured credential can satisfy them, and otherwise fail with the exact missing permission | P1 |
| 4 | No advertised surface still offers the retired `networkMode` field | P2 |

## Decisions (locked by evidence + kongming counsel)

- **Instance-wide, single-row persisted default** in the runner's state database,
  not a per-principal preference: network posture is an instance policy, so two
  principals must not get different postures for the same request.
- **Resolution order:** explicit `workspace_open.networkProfile` > persisted
  instance setting > runner environment/built-in default. `null` in the update
  API explicitly means "use the runner default".
- **Built-in and shipped default becomes `dependency-access`.** Kongming accepted
  the resulting availability risk: an instance without the attested host firewall
  fails workspace opens closed with `DEPENDENCY_EGRESS_UNAVAILABLE`. There is no
  silent fallback to `network-none`.
- **Subagent isolation stays strict**: `agent_spawn`/admission still require
  `network-none`; only the error message gains the remediation.
- **GitHub credential selection is verified before execution.** Mint the App
  token with the union of permissions the action needs, read back the granted
  permissions GitHub returns, and prefer the operator fallback when the App
  cannot satisfy the union. No retry after a `403` (the operation may already
  have side effects).
- **Capability advertisement reflects granted permissions** captured during
  installation verification, not merely "an App id is configured".

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Instance default network profile](./phase-01-instance-default.md) | Pending |
| 2 | [Phase 2: Dashboard Settings page](./phase-02-dashboard-settings.md) | Pending |
| 3 | [Phase 3: GitHub write authorization](./phase-03-github-authorization.md) | Pending |
| 4 | [Phase 4: Retire the networkMode advertisement](./phase-04-retire-networkmode.md) | Pending |
| 5 | [Phase 5: Documentation, skill sync, verification](./phase-05-docs-verification.md) | Pending |

Phase 1 must land before Phase 2 (the dashboard calls the operations Phase 1
defines). Phase 3 and Phase 4 are independent of Phases 1-2 and of each other.
Phase 5 runs last.

## Success Criteria

- [ ] `workspace_open` without `networkProfile` starts an executor on
      `dependency-access`; the effective default is reported by
      `workspace_capabilities` and by the dashboard Settings page.
- [ ] The operator can set `network-none` or `dependency-access`, or reset to the
      runner default, from `/dashboard/settings`, and the choice survives a
      runner restart.
- [ ] `dependency-access` remains attested before every executor start; readiness
      is checkable from the Settings page; failure is `DEPENDENCY_EGRESS_UNAVAILABLE`
      with remediation, never a silent downgrade.
- [ ] `agent_spawn` in an egress workspace returns a conflict that names the
      `networkProfile: "network-none"` remediation.
- [ ] `github_action` with `issue_create` uses the operator fallback credential
      when the App installation cannot write issues, and otherwise returns
      `GITHUB_PERMISSION_MISSING` naming the missing App permission and the
      fallback option.
- [ ] `workspace_capabilities` reports `issuesWrite`/`pullRequestsWrite` from
      granted installation permissions when a verified installation record
      exists.
- [ ] No generated reference, MCP tool schema, or dashboard markup presents
      `networkMode` as usable.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test:unit`,
      `npm run plugin:check`, `npm run docs:check` pass.

## Validation Log

### Gate evidence (2026-09-14)

- **Advisory supervision (`--advice`):** two kongming consultations ran before the
  gates. The first locked the design (instance-wide persisted default, dashboard-only
  internal operation, fail-closed egress, pre-execution credential selection with
  union minting). The second flagged two Phase 3 corrections that are now in the
  plan: installation action permissions are three-state (`none`/`read`/`write`,
  never defaulted to `read`) and the per-action scope table is exact rather than
  `pr_*`-family based.
- **Claim verification:** 64 claims checked against the working tree; 50 verified,
  9 failed, 5 unverified. Every failure was mechanical and is corrected in place:
  `.vitepress/config.ts` (not `.mts`); `createDashboardAssetsRouter` has a path
  allowlist that must register `/settings`; `DashboardResponseOperation` needs the
  three settings members; `PALETTE_PAGE_COMMANDS` uses `{id, group, label, hint, href}`;
  Phase 2 Task 2.3 must also drop `dashboard-render.js:20`; the state-store symbol is
  `getPreferredWorkspace`; Phase 3's premise now separates the already-correct
  classified code from the missing message and missing pre-execution selection; and
  Task 3.2 now explicitly updates the existing `permissionScope` assertions in
  `brokered-github-operations.test.ts`.
- **Red-team review:** 4 blockers, all resolved in the plan. (1) The mint-failure
  decision table is now explicit — grant denial reaches the fallback and otherwise
  produces `GITHUB_PERMISSION_MISSING`, while repository-authorization and
  infrastructure failures keep their existing behaviour, with rejected-mint tests
  required. (2) Dashboard transport is complete: assets allowlist, response-operation
  union, palette contract, reset handling, renderer. (3) The unsound self-heal was
  removed: an action token reports the *requested* level, so persisting it could
  downgrade a known `write` grant; convergence stays with installation verification.
  (4) Coverage now names the local capability producer, in-memory installation
  stores, both SQLite column paths, and Phase 4's dependency on Phase 2.
- **Confirmed non-defects:** the new POST routes inherit the existing CSRF/Origin
  middleware; a persisted setting cannot bypass attestation because executor starts
  still call `ensureProfileReady`; the Docker integration suites pin their profiles
  explicitly, so none of them breaks from the default flip and their assertions stay
  as-is.
- **Open decisions:** none. The remaining risk is operational, not technical: an
  instance whose host firewall is not provisioned fails workspace opens closed by
  design, and the operator reverts through the Settings page or the environment
  variable.

### Whole-Plan Consistency Sweep

- `plan.md` premise, decisions, and success criteria agree with phases 1-5 after the
  corrections above.
- Phase order: 1 → 2 (dashboard calls the operations), 2 → 4 (shared
  `apps/api/dashboard/index.html`), 3 independent, 5 last.
- No stale symbol names remain: `PAGE_COMMANDS`, `docs-site/.vitepress/config.mts`,
  `preferredWorkspace`, and the single-scope `permissionScope` mint are all
  replaced.
- The `networkMode` cleanup is owned once, by Phase 2 Task 2.3, and Phase 4 Task 4.3
  is a verification pointer to it.

<!-- slug: workspace-network-default-settings -->

