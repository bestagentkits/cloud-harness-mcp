---
phase: 5
title: "Verification, ship to main, and deploy convergence"
status: pending
priority: P1
effort: "4h"
dependencies: [4]
---

# Phase 5: Verification, ship to main, and deploy convergence

## Goal

The three UI capabilities are proven in a real browser against a served shell,
the repository gate passes, the change is merged to `main`, and CI plus the
resulting production deploy are watched to green.

## Context Links

- `AGENTS.md` — change workflow, gates, and the deploy-authorization boundary
- `docs/development.md:121-133` — release/version semantics
- `docs/deployment.md:247-276,306-346` — deploy command, canary, post-deploy verification
- `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/workflows/release.yml`
- `apps/api/test/dashboard-app-mount.test.ts` — the pattern for serving the assets router standalone

## Key Insights

- **A browser smoke is mandatory, not ceremonial.** CSP is `default-src 'none'`
  with `style-src 'self'` and no `'unsafe-inline'`
  (`apps/api/src/dashboard-security.ts`). Neither the static-file contract test
  nor the fake-DOM behavior test evaluates CSP or lays out a page, so a palette
  or theme control that violates CSP passes every automated gate while being
  broken for every real user.
- **The production deploy is automatic.** `deploy.yml` triggers on
  `workflow_run: [CI] completed` for `head_branch == 'main'` and runs
  `sudo -n /usr/local/sbin/cloud-harness-deploy '$RELEASE_SHA'` over SSH. Nobody
  dispatches it; merging to `main` **is** the deploy trigger.
- **The owner authorized this deploy in this session** (ship target `main`,
  merge and watch to green). That authorization covers the merge and the
  convergence loop — not a manual SSH, not a `workflow_dispatch`, not a rollback.
- `dev` is not a valid target: it is 231 commits behind `main` and untouched
  since 2026-08-18, which is why the beta channel was overridden.
- Production runs the **pre-version-bump** merge commit, so the deployed version
  string legitimately lags the newest tag by one release. The sidebar labels it
  "Server version" for that reason; Task 4.3 tracks the pipeline defect.

## Requirements

- Functional: in a real browser, `CMD+K` and `CTRL+K` open the palette, arrow keys
  traverse options, Enter navigates, Escape closes and restores focus.
- Functional: the theme icon cycles through all three states and persists.
- Functional: the sidebar shows the version and hides it when the rail collapses.
- Functional: the palette and theme work at a 375 px viewport.
- Non-functional: zero CSP violations in the browser console on every dashboard
  page.
- Non-functional: the applicable repository gate passes.
- Delivery: the change is merged to `main`; CI on `main` and the resulting deploy
  workflow reach a terminal green state, or a true external blocker is recorded.

## Architecture

Verification harness (throwaway, deleted at the end of this phase). It must mount
the **real security middleware**, not just the assets router — otherwise the CSP
assertions are vacuous, because `createDashboardAssetsRouter()` emits no CSP:

```
scripts/smoke-dashboard.mjs  (temporary, not committed)
  express()
    └─ /dashboard   requestSecurity(config)              (owned by dashboard-security.ts)
                    -> dashboardSecurity(config)          CSP + host/origin enforcement
                    -> principalRequestLimits()           the REAL 8-concurrent / 120-per-min limiter
                         ├─ /api/v1/session      -> { csrfToken }
                         ├─ /api/v1/preferences  -> Set-Cookie ch-dashboard-theme=<value>   (mirrors dashboard-router.ts:96-106)
                         ├─ /api/v1/*            -> canned allowlisted list payloads
                         └─ otherwise            -> createDashboardAssetsRouter()
  listens on 127.0.0.1:<port>
```

Harness configuration must satisfy `dashboardSecurity`'s own checks
(`apps/api/src/dashboard-security.ts:12-27`): the request `Host` must be in
`publicHosts`, and any request carrying an `Origin` header — which every mutating
request must send — must match both the host and an entry in `allowedOrigins`.
Use `publicHosts: ['127.0.0.1']` and
`allowedOrigins: ['http://127.0.0.1:<port>']`, and drive the browser at
`http://127.0.0.1:<port>/dashboard/...`.

Mounting the real limiter is what makes the concurrency assertions meaningful: it
is the same code path that returns `429` in production.

Delivery sequence:

```
targeted suites -> full gate -> PR (base main) -> review/fix -> merge
   -> watch CI on main -> watch deploy.yml -> record deploy outcome
```

## Related Code Files

- Create (temporary, must be deleted): `scripts/smoke-dashboard.mjs`
- No production file changes expected in this phase except fixes that Phase 5
  verification or review proves necessary.

## Implementation Steps

### Task 5.1 — Browser smoke against a served shell

- **Goal:** every new capability is observed working in a real browser with the
  console clean.
- **Target files and symbols:** create `scripts/smoke-dashboard.mjs` (temporary).
- **Steps:**
  1. Write the harness described in Architecture, mounting `dashboardSecurity`
     and `principalRequestLimits` in addition to the assets router. Stub the
     seven endpoints the palette fans out to (`/workspaces`, `/projects`,
     `/secrets`, `/api-keys`, `/provider-credentials`, `/agent-model-profiles`,
     `/artifacts`) with small canned arrays that include at least one entry whose
     label contains `<` and `>` to exercise escaping, and one seed secret row
     carrying a `description` and one knowledge row carrying a `content` so the
     "never indexed" assertion is meaningful.
  2. Implement `/api/v1/preferences` to mirror the real handler's cookie
     semantics (`apps/api/src/dashboard-router.ts:96-106`), so theme persistence
     is observable across a reload. Do not simply return `{ theme }`.
  3. Start it with the `hub` process facility (not a bare background shell).
  4. **Before any browser assertion**, fetch `/dashboard/overview` and assert the
     response carries the exact production CSP header value from
     `apps/api/src/dashboard-security.ts:29`. If it is absent, STOP — the rest of
     the smoke cannot prove CSP compliance.
  5. Open `/dashboard/overview` in the browser.
  6. Assert the sidebar shows the version from `apps/api/package.json` with a
     leading `v`, and that collapsing the rail hides it.
  7. Open the palette by clicking `#open-palette` and assert page commands are
     listed before any network response settles.
  8. **Concurrency assertion:** with `/workspaces` delayed to ~2 s, open the
     palette and record the maximum number of simultaneous in-flight requests the
     harness observes. It must never exceed 3. Then press Escape and reopen
     before the first load settles, and assert the harness served **no additional
     requests for that fan-out** (single-flight).
  9. **Throttle assertion:** configure the harness to return `429` with
     `Retry-After: 1` for `/projects` on the first attempt only. Assert the
     palette still opens, that the remaining sources are present, and that
     reopening the palette after the throttle clears **does** return the project
     rows — proving the failed source was not cached as empty.
  10. **No-leak assertion:** assert no rendered palette option contains the seeded
     secret `description` string or the seeded knowledge `content` string.
  11. Type a term matching a stubbed workspace, assert the row appears, then use
      ArrowDown and Enter and assert navigation occurred.
  12. Re-open, press Escape, and assert focus returned to the trigger.
  13. Click the theme icon three times, asserting the icon and
     `documentElement.dataset.theme` traverse system → light → dark and that the
     label announces the next state. Then reload the page and assert the chosen
     theme is still applied from the cookie — proving persistence, not just local
     DOM mutation.
  14. Collect browser console messages on every page visited and assert no CSP
     violation and no error was logged.
  15. Repeat the palette and theme checks at a 375 px viewport.
  16. Stop the harness and delete `scripts/smoke-dashboard.mjs`.
- **Success criteria:** every assertion above holds, including the CSP header
  assertion, the ≤3 concurrency bound, the single-flight check, the `429`
  retryability check, the no-leak check, and cookie-backed theme persistence; the
  console reports no CSP violation; the temporary script is gone.
- **Verify:** the browser assertions pass,
  `curl -sI http://127.0.0.1:<port>/dashboard/overview` shows the
  `content-security-policy` header, and `test -f scripts/smoke-dashboard.mjs`
  exits non-zero (file removed).

### Task 5.2 — Run the applicable repository gate

- **Goal:** the change passes the repository's own gates.
- **Target files and symbols:** none.
- **Steps:**
  1. Run the targeted dashboard suites first:
     `npx vitest run apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-ui-behavior.test.ts apps/api/test/dashboard-app-mount.test.ts apps/api/test/dashboard-router.test.ts apps/api/test/knowledge-dashboard-ui.test.ts apps/api/test/dashboard-models-router.test.ts`.
  2. Run `npm run lint`.
  3. Run `npm run typecheck`.
  4. Run `npm run test:unit` (this host is Windows, so `npm run verify`'s POSIX
     shell fixture tests are Linux-CI-only per `AGENTS.md`).
  5. Run `npm run docs:build` to confirm the docs-site change builds.
  6. Record any failure with its exact command and output.
- **Success criteria:** all five commands exit 0, or a failure is recorded as a
  pre-existing or environment limitation with evidence.
- **Verify:** each command exits 0.

### Task 5.3 — Local code review

- **Goal:** an independent reviewer passes the diff, or its findings are fixed.
- **Target files and symbols:** the full working-tree diff.
- **Steps:**
  1. Run an independent review over the diff with a fresh-context subagent,
     focused on: CSP compliance (no `element.style`, no inline handlers), no
     client storage, correct escaping, `aria-selected`/`aria-activedescendant`
     handling, the tri-state theme contract, the version-injection path, and
     whether any test was weakened rather than extended.
  2. Fix every Critical and Important finding.
  3. Re-run the affected suites after each fix.
  4. Re-run Task 5.1's smoke if any of Phases 1-3 changed.
- **Success criteria:** no outstanding Critical or Important finding; the diff
  contains no weakened assertion.
- **Verify:** the review report lists 0 Critical and 0 Important, and the
  targeted suites exit 0.

### Task 5.4 — Create the issue and open the PR against `main`

- **Goal:** the work is tracked and opened for review against the live trunk.
- **Target files and symbols:** GitHub issue and pull request in
  `bestagentkits/cloud-harness-mcp`.
- **Steps:**
  1. Create the tracking issue using the pipeline issue template from the run's
     report template: Outcome, How It Works (three bullets), a `flowchart TD`
     architecture diagram, Implementation metadata, Acceptance Criteria, and
     Pipeline State.
  2. Ensure these labels exist, creating any that are missing:
     `ready to cook`, `in progress`, `ready to ship stable`,
     `ready to ship beta`.
  3. Add `in progress` before implementation if not already set, and remove
     `ready to cook`.
  4. Link the plan: record the branch, the relative plan path, and the route
     (`feature`) on the issue, then run
     `ak plan update <plan-id> --issue <issue-number>`.
  5. Push the branch and open the PR with base `main` — **not** `dev`. Title in
     Conventional Commit form with a `feat(dashboard)` scope so the release
     computes a minor bump.
  6. The PR body must state that merging triggers an automatic production deploy
     of the merge commit to the VPS.
  7. Include the temporary-path note if any scratch file were committed — there
     must be none.
- **Success criteria:** the issue exists with the labels, the plan is linked by
  issue number, and the PR targets `main`.
- **Verify:** `gh pr view <number> --json baseRefName,url` exits 0 and
  `baseRefName` is `main`.

### Task 5.5 — Review the PR, then merge and converge

- **Goal:** the PR is reviewed, merged, and CI plus the deploy reach a terminal
  green state.
- **Target files and symbols:** the pull request and its checks.
- **Steps:**
  1. Review the PR for correctness, regressions, and security; reply to
     actionable review comments and fix them in the branch.
  2. Confirm all required checks are terminal and green before merging. Do not
     merge with a pending or failing required check.
  3. Merge using the repository's allowed merge method. Never force push, never
     push directly to `main`.
  4. Watch CI on `main` for the merge commit; if it fails with a deterministic
     repo-fixable error, create a follow-up fix branch from `main`, fix, ship,
     review, and merge again.
  5. Watch the `deploy.yml` run triggered by that CI success. If it fails with a
     deterministic repo-fixable error, apply the same follow-up loop.
  6. Record the deploy run URL, the deployed SHA, and whether the run reached
     success.
  7. If a failure requires a VPS credential, SSH access, a `workflow_dispatch`,
     or a `production` environment approval, stop and record it as an external
     blocker — do not attempt to work around it.
  8. After the deploy is green, confirm the deployed version by comparing the
     sidebar readout to the pre-bump manifest, and report the expected one-release
     lag rather than treating it as a failure.
  9. Apply `ready to ship stable` to the issue and the PR, and remove
     `ready to cook` and `in progress`.
- **Success criteria:** CI on `main` is green; the deploy workflow is terminal
  with success, or an external blocker is recorded with the exact failing run and
  reason.
- **Verify:** `gh run list --branch main --limit 5 --json name,conclusion,headSha`
  shows the CI and deploy runs for the merge commit with `conclusion: success`.

## Tests Before (TDD)

Not applicable — this phase verifies previously written tests are green and adds
no new behavior.

## Tests After (TDD)

Not applicable. The browser smoke in Task 5.1 is the verification artifact for
the DOM- and layout-coupled behavior that the fake-DOM suite cannot reach; it is
throwaway by design and is not committed as a test, because a script that stubs
its own API responses would assert the stub rather than the product.

## Refactor

Deletes the temporary smoke harness after it has served its purpose.

## Todo

- [ ] Task 5.1: browser smoke (hotkey, palette, theme, version, CSP, 375 px)
- [ ] Task 5.2: targeted suites, lint, typecheck, test:unit, docs:build
- [ ] Task 5.3: independent diff review and fixes
- [ ] Task 5.4: tracking issue, labels, plan link, PR base `main`
- [ ] Task 5.5: PR review, merge, CI on `main`, deploy convergence
- [ ] Delete `scripts/smoke-dashboard.mjs`

## Success Criteria

- Browser smoke proves the palette, the theme cycle, the version readout, the
  **production CSP header**, the ≤3 concurrent bound, single-flight reuse, `429`
  retryability, and cookie-backed theme persistence, with a clean console.
- `npm run lint`, `npm run typecheck`, `npm run test:unit`, and `npm run docs:build`
  all pass.
- The PR base is `main` and it is merged through the repository's allowed method.
- CI on `main` succeeds for the merge commit.
- The deploy workflow reaches a terminal state, recorded with its run URL and SHA.
- No scratch file, secret, or local absolute path is committed.

## Risk Assessment

- **Risk:** the merge to `main` triggers a production deploy that fails
  mid-flight. **Mitigation:** the deploy script takes a nonblocking host lock,
  snapshots state before checkout, and restores the previous release plus database
  and artifacts on error (`docs/deployment.md:257-278`). On a deterministic
  failure, follow the same fix-and-reship loop; on a credential or approval
  blocker, stop and record it.
- **Risk:** the smoke harness serves the page without the production CSP and the
  CSP gate becomes a false positive. **Mitigation:** the harness mounts
  `dashboardSecurity(config)`, Task 5.1 asserts the exact CSP header value
  *before* any browser assertion, and the harness must stop if it is absent.
- **Risk:** the palette fan-out exceeds the eight-concurrent per-principal budget.
  **Mitigation:** the harness mounts the real `principalRequestLimits`, and Task
  5.1 asserts a ≤3 concurrent bound plus a single-flight check.
- **Risk:** a throttled source is cached as empty and the palette silently misses
  a resource forever. **Mitigation:** Task 5.1 induces a one-shot `429` on
  `/projects` and asserts the rows appear once the throttle clears.
- **Risk:** a required check is pending and merging early ships a broken revision.
  **Mitigation:** Task 5.5 step 2 requires terminal green before merge.
- **Risk:** the smoke harness masks a real defect because its responses are
  stubbed. **Mitigation:** the harness is used only for DOM, layout, security
  headers, concurrency, and CSP behavior — never to validate server data. Server
  behavior is covered by the mount, router, and model-router suites.
- **Risk:** the deployed sidebar version looks one release stale and is mistaken
  for a regression. **Mitigation:** the label is "Server version", the delivery
  record states the expected lag, and Task 4.3 tracks the pipeline defect.
- **Risk:** a `dev`-targeted PR is opened by habit. **Mitigation:** Task 5.4
  requires an explicit base assertion.

## Security Considerations

- No secret, token, or private environment value is written to the issue, the PR,
  a comment, or the smoke script. The harness uses canned non-sensitive fixtures.
- No manual SSH, no `workflow_dispatch` of the deploy workflow, and no direct
  push to `main` — the automated CI-gated path is the only deploy mechanism used.
- The smoke harness binds to loopback only and is deleted at the end of the
  phase; it must never be committed.
- Rollback is an owner operation and is not attempted by an agent.

## Next Steps

After convergence, the run completes. Remaining operator follow-ups are reported
in the completion report — principally the release-pipeline ordering issue from
Task 4.3 and the stale `dev` branch.

## Failure Protocol

If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
