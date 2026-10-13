# Issue #220 — final Definition-of-Done mapping, with the verification run for each bullet

This supersedes the earlier mapping, which named PRs and test files but not the verification
runs. Each bullet below names the shipped surface, the PR and commit that carried it, the
test that asserts it, and the CI run that covered the merged state.

**Where a phase's own post-merge run did not conclude:** per the published CI ledger, the
runs attached to the #227–#237 merge commits are `cancelled` (superseded by
semantic-release's `[skip ci]` commit under the workflow's `cancel-in-progress`), and #234's
was `failure`. The cumulative merged state is therefore verified by the runs listed below,
which do conclude — most importantly main CI `35578767877` at `7496cb2` (the last epic
merge, `success`) and the runs at the corrective and hardening merges.

| # | Definition-of-Done bullet | Shipped in | Asserting test | Verification run / command |
|---|---|---|---|---|
| 1 | `/dashboard` is a decision-oriented Overview; tiles drill into filtered views; workspaces at `/dashboard/workspaces`; legacy redirect | #225 `c793e18`, #235 `f546415` | `dashboard-pages.test.ts`, `dashboard-overview.test.ts`, `dashboard-app-mount.test.ts` (redirects) | main CI `35578767877`; ledger row for `f546415` |
| 2 | One canonical page registry owns identity/route/group/title/help/icon/palette; nav, active state, palette, routing, headings and the shell allowlist derive from or assert parity | #225 `c793e18` | `dashboard-pages.test.ts` (bidirectional parity), `dashboard-ui-contract.test.ts` | main CI `35578767877` |
| 3 | Home/Operate/Configure/Data/Admin nav; Profile off the rail but in the chip and palette; GitHub + MCP Servers folded into one Integrations page | #225 `c793e18`, #234 `190a2dd` | `dashboard-pages.test.ts` (nav order, audit no longer in the rail), `dashboard-ui-contract.test.ts` | main CI `35578767877` |
| 4 | Workspace cockpit with nine contextual sections, header posture and Renew/Finalize/More actions | #229 `e74bb65`, #230–#233 | `dashboard-cockpit.test.ts`, `dashboard-agents.test.ts`, `dashboard-runtime.test.ts`, `dashboard-git.test.ts`, `dashboard-automation.test.ts` | main CI `35578767877`; corrective run `35580248577` |
| 5 | Agents first-class: hierarchy + flat fallback, detail Overview/Usage/Logs/Messages, budgets, steer/follow-up/cancel | #230 `fbaec24` | `dashboard-agents.test.ts`, `dashboard-router.test.ts` (agent redaction) | main CI `35578767877` |
| 6 | Runtime actionable: task detail/cancel, internal-SVG DAG with table fallback, read-only bounded sessions | #231 `2c2453e` | `dashboard-runtime.test.ts` | main CI `35578767877` |
| 7 | Git contextual with Finalize as the happy path and collapsed advanced operations | #229 `e74bb65`, #232 `1e28330` | `dashboard-git.test.ts` | main CI `35578767877` |
| 8 | Skills/hooks discoverable by lifecycle; Deploy targets with confirm-before-run | #233 `d53b1b8` | `dashboard-automation.test.ts` | main CI `35578767877` |
| 9 | Activity Center with six filters, durable-vs-live labels; Approvals inbox with audited decisions and pending-only badge | #234 `190a2dd` | `dashboard-activity.test.ts`, `dashboard-pages.test.ts` | corrective run `35580248577` (this phase's own run `35577620013` **failed** — see the shortfall) |
| 10 | Browser calls Dashboard adapters only; server-side read-only projections replace fan-out | #235 `f546415`, #236 `a932fc5` | `dashboard-overview.test.ts`, `dashboard-analytics.test.ts`, `dashboard-router.test.ts` | main CI `35578767877` |
| 11 | Eight decision charts, internal SVG, accessible, dependency-free | #236 `a932fc5`, #240 `5d05334` | `dashboard-analytics.test.ts`, `dashboard-agent-series.test.ts` | #240's required check `35581425169` (`quality` pass 2m56s, `docker-integration` pass 3m25s) → merge `20ff3ad2`; local `npx vitest run dashboard` = 26 files / 330 tests |
| 12 | Security, CSP, WCAG and reduced-motion constraints intact | #225–#237 | `dashboard-ui-contract.test.ts` (CSP, no gradient/inline style, focus guard, one endless animation, reduced-motion collapse), `dashboard-design-tokens.test.ts` | `npx eslint .` exit 0; main CI `35578767877` |
| 13 | Tests and docs reflect the architecture | #225–#240 | `docs/design-guidelines.md`, `docs-site/dashboard/*` | `npm run docs:build` clean (46 markdown twins); its dead-link check caught the missing Integrations page |
| 14 | Every phase PR green before merge, auto-merged, post-merge CI converged | — | — | **NOT MET for the phase merges.** Phase #234 merged with a failing check (`35577620013`), and no phase merge was CI-gated because `main` had no required status checks. Remediation, applied and demonstrated since: defect fixed by #235; `quality` is now **required** on `main`; the gate refused #239 while pending, passed it in 3m1s (`35580248577`), merged `8134d52`, and its post-merge run `35580603915` concluded `quality: success`; #240 was gated the same way (`35581425169` → merge `20ff3ad2`). This is a historical property of the phase merges and cannot be retrofitted. |

## Deferred items, stated rather than implied

- The execution-health and cost series cover the **retained agent window**, not a dated
  ledger; the chart captions and the section prose say so.
- Sessions remain read-only by design (the issue's own constraint).
- No optimistic toggles on generation-fenced surfaces; the UI reports the server-confirmed
  result.
- Reduced motion is verified at the CSS contract level; the browser driver used for QA
  exposes no media-feature emulation.
