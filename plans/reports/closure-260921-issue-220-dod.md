# Dashboard UX overhaul — Definition of Done, with evidence

Delivered as the sequence of phase PRs the issue asked for. Each phase shipped green
(`npx vitest run dashboard`, API typecheck, eslint) and was auto-merged; the final state
is `main` at PR #238.

| # | Definition-of-Done bullet | Evidence |
|---|---|---|
| 1 | `/dashboard` is a decision-oriented Overview | #235 — Needs attention, Running now, Cost (scope stated), Expiring soon; every tile links to its filtered view. `apps/api/test/dashboard-overview.test.ts` and the decision-tile assertions in `dashboard-ui-behavior.test.ts`. |
| 2 | Workspaces live at `/dashboard/workspaces` | #225 — registry, route migration and the `/dashboard/overview` redirect; `dashboard-pages.test.ts` (bidirectional allowlist parity), `dashboard-app-mount.test.ts` (redirects). |
| 3 | Global navigation follows operator intent | #225 introduced Home / Operate / Configure / Data / Admin; #234 moved Audit into the Activity Center, leaving the rail at 14 destinations with Profile reachable only from the top-bar chip and palette. |
| 4 | Workspace detail is a cockpit | #229 added the shell, header posture (Renew / Finalize / More actions), Summary and Needs-attention; #230–#233 filled Agents, Runtime, Git, Automation and Deploy; `dashboard-cockpit.test.ts` covers the nine tabs and lease thresholds. |
| 5 | Agents are first-class | #230 — global and workspace lists, accessible hierarchy with a flat parent-named fallback, detail Overview/Usage/Logs/Messages, budget edge cases, steer/follow-up/cancel, bounded redacted logs; `dashboard-agents.test.ts`, and redaction cases in `dashboard-router.test.ts`. |
| 6 | Runtime is actionable, with a task DAG | #231 — task status/duration/exit/dependencies/bounded output/cancel, internal-SVG DAG with focusable text-labelled nodes, cycle guard and table fallback, read-only bounded session view; `dashboard-runtime.test.ts`. |
| 7 | Git status/diff/history/finalize are contextual | #232 — status parsed from porcelain, bounded staged/unstaged diff with truncation notice, commits, worktrees under disclosure, six collapsed advanced operations; Finalize shipped in #229. `dashboard-git.test.ts`. |
| 8 | Skills, hooks and deployments are discoverable in workspace context | #233 — hooks grouped by the five lifecycle events beside an ordered text pipeline, resolved skills with a guarded script runner, deployment targets with result/duration/failure detail and confirm-before-run; `dashboard-automation.test.ts`. |
| 9 | Pending privilege grants are actionable from Approvals | #234 — `/dashboard/approvals` inbox with command, workspace, cwd, digest and times, audited Approve/Reject, and a rail badge that exists only while something is pending; `dashboard-activity.test.ts`. |
| 10 | Activity is a coherent timeline with Audit semantics retained | #234 — one event grammar across All / Agents / Tasks / MCP / Deployments / Audit, with each row labelled **Retained audit** or **Live runtime**; `/dashboard/audit` keeps its route and palette entry. |
| 11 | Useful charts, accessible and dependency-free | #236 — retained-audit volume, cost and tokens by model profile, budget burn, expiry buckets and MCP reliability (p50/p95 from gateway traces), all internal SVG with focusable marks, accessible names, table fallbacks, no CDN; `dashboard-analytics.test.ts`. |
| 12 | Security, CSP, WCAG and reduced-motion constraints intact | `dashboard-ui-contract.test.ts` (CSP surface, no gradient/inline style/external asset, focus-indicator guard, one endless animation = the loading skeleton, tokenised motion, reduced-motion collapse), `dashboard-design-tokens.test.ts`, and the redaction cases added with every adapter. |
| 13 | Tests and docs reflect the new architecture | `docs/design-guidelines.md` gained a section per shipped surface (registry, resource pages, cockpit, agents, runtime, Git, automation/deploy, activity/approvals, decision overview, analytics, motion); the official docs site was resynced in #238, whose dead-link check caught and forced the missing Integrations page. |

## Verification at closure

- `npx vitest run dashboard` — 25 files, 323 tests, passing.
- `npm run typecheck -w @cloud-harness/api`, `npx eslint` on the changed trees — clean.
- `npm run docs:build` — clean; 46 Markdown twins emitted.
- Browser sweep against the real shell with a stubbed BFF: desktop and ~375px with zero horizontal overflow, dark and light tokens applied, navigation groups `Home/Operate/Configure/Data/Admin` with exactly one `aria-current`, the four decision tiles (Cost reading "Not reported" with no agent data), the Analytics section, the approvals badge hidden with nothing pending, no error alert, and a keyboard path from the skip link to an interactive target.

## Known residuals (deliberate, and stated in the product where they apply)

1. **Cost and execution-health *trends***
   are not charted. The harness retains per-agent usage and the redacted audit record, not a dated cost or outcome ledger. The Analytics section states this in the UI rather than drawing a curve the data cannot support. Both the Overview cost tile and the metrics projection name the scope they measured.
2. **Cockpit attention reasons** cover what the dashboard can observe (lease thresholds, failed workspace, network quarantine, dirty Git, and — from the Overview projection — failed/limit-exceeded/timed-out agents and pending approvals). Task-level and integration-level reasons surface in the Runtime and Activity surfaces that own that data.
3. **Reduced motion** is verified at the CSS contract level (the global `prefers-reduced-motion` block collapses every animation and transition, asserted by test) rather than by emulating the media feature in the browser driver used for QA.
4. **Optimistic enable/disable** is not implemented: the toggles that could use it answer with generation-fenced results that can conflict, so the UI keeps the server-confirmed flow and reports the outcome in the live region.
5. **Sessions remain read-only** in the dashboard by design, per the issue's own constraint that the Dashboard must not become an unrestricted terminal.

Everything in the issue's Definition of Done is satisfied as listed above; the residuals are scope the issue either excluded or could not support from retained data.
