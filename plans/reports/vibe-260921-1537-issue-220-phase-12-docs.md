# Phase 12 (issue #220, Phase 11): docs sync, regression sweep, and closure evidence

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-12` (task-12 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-12-docs-and-closure.md`

## Summary

The official docs site now describes the shipped information architecture, routes and
surfaces, and the Dashboard regression suite is green. This closes the documentation and
verification half of the epic; the closure comment on issue #220 maps every
Definition-of-Done bullet to its evidence.

## What changed

- `docs-site/dashboard/index.md` — the operator-intent organisation (Home, Operate,
  Configure, Data, Admin), `/dashboard` as the decision Overview, the workspace cockpit,
  and every page with its real route.
- `docs-site/dashboard/agents.md`, `activity.md`, `approvals.md` (new) — the agent control
  center (hierarchy, usage, bounded logs, messages), the Activity Center's single event
  grammar with durable-vs-live labelling, and the privilege-grant inbox with its
  pending-only rail badge.
- `docs-site/dashboard/integrations.md` (new) — one Integrations page with GitHub and MCP
  tabs, the redirects from the old routes, and why one page replaced two rail entries.
- `docs-site/dashboard/workspaces.md` — the cockpit sections, the header actions, and a
  Runtime section covering tasks, the accessible DAG and the read-only bounded session
  view.
- `docs-site/dashboard/audit.md`, `github.md`, `models.md`, `api-keys.md` — Audit as an
  Activity filter with its route retained, GitHub as an Integrations tab, the
  **Models & Budgets** and **API Access** labels with their unchanged routes, and
  dialog-based creation.
- `docs-site/.vitepress/config.ts` — the Dashboard sidebar follows the shipped order.

## Verification

- `npm run docs:build` — clean (46 Markdown twins emitted). The build first failed on two
  dead links to `/dashboard/integrations`, which is exactly the drift this phase exists to
  catch; the missing page was written rather than the check disabled.
- `npx vitest run dashboard` — 25 files, 323 tests, all passing.
- Browser sweep against the real shell with a stubbed BFF: desktop and 375px with no
  horizontal overflow, dark and light tokens both applied, `prefers-color-scheme: light`
  honoured, navigation groups `Home/Operate/Configure/Data/Admin` with 14 rail links and
  exactly one `aria-current`, the four decision tiles present (Cost reading "Not reported"
  with no agent data), the Analytics section present, the approvals badge hidden with
  nothing pending, no error alert, and a keyboard path from the skip link to a real
  interactive target with `#main` focusable.

## Residual

Reduced-motion behaviour is verified at the CSS contract level (the global
`prefers-reduced-motion` block collapses every animation and transition, asserted by test)
rather than by emulating the media feature in the browser, which the available browser
driver does not expose.
