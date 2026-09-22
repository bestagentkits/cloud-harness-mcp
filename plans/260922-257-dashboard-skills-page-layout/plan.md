---
title: "Dashboard Skills page: coherent layout and no duplicated library rows"
description: "Give /dashboard/skills a real tab strip, a labelled filter bar, a framed library, a dismissible detail panel, and a create/edit form that does not compete with its own labels; stop the card list from duplicating every library row on desktop."
status: completed
priority: P2
effort: "1d, single PR"
tags: [dashboard, skills, ux, css, accessibility]
created: 2026-09-22
issue: 257
branch: enhance-dashboard-skills-ui
source: "https://github.com/bestagentkits/cloud-harness-mcp/issues/257"
---

# Dashboard Skills page layout (issue #257)

## Overview

Issue [#257](https://github.com/bestagentkits/cloud-harness-mcp/issues/257) reports that
`/dashboard/skills` is visually cluttered, with a screenshot from production. This plan turns that
screenshot into six verified defects, fixes all six, and keeps every public contract intact.

The page has **no page-specific CSS at all**. `renderSkillsSkeleton()`
(`apps/api/dashboard/dashboard-render.js:891-962`) emits class names that appear nowhere in
`apps/api/dashboard/dashboard.css`: `.skills-toolbar`, `.skills-tabs`, `.skills-panel`,
`.skills-search`, `.skills-bulk-bar`, `.skills-diff`, `.skills-revisions`. The only two
`skills-*` rules in the stylesheet are `.skills-chips` and `.skills-conflicts`
(`dashboard.css:459-462`), and both belong to the open-workspace *dialog*, not this page.

Two mechanisms produce the clutter:

1. **The global form rule.** `form { display: flex; align-items: end; flex-wrap: wrap; gap: var(--space-3); }`
   (`dashboard.css:294`) applies to both `.skills-toolbar` and `#skill-editor`, because both are
   `<form>` elements. Every label and control therefore becomes a sibling on one wrapping,
   baseline-aligned row. This is the exact mechanism behind the screenshot line reading
   `Search [input] Provider [Any] State [Any] Tag [input] Sort [Name]`, and behind
   `Create a custom skill · my-skill · Slug · Display name · Instructions` on a single line with a
   full-bleed textarea underneath.
2. **A missing visibility rule.** The skeleton ships both a table and a card list for the same rows
   (`dashboard-render.js:905-906`). Only `.desktop-table` is hidden at the mobile breakpoint
   (`dashboard.css:600`); `.card-grid` is `display: grid` at every width. Every other table/card pair
   in this codebase uses `<ul class="mobile-list">`, whose base rule is `display: none`
   (`dashboard.css:329`). The library therefore renders every skill twice on desktop, which is why
   the screenshot shows the empty-library sentence twice.

`docs/design-guidelines.md` already asserts that "the Skills library follows this rule: its five
columns cannot fit 375px … Both renderings carry the same controls and both are wired". The wiring is
correct; the hiding is missing. The documentation and the code disagree, and the code is wrong.

Three further defects are the same class of problem — markup that exists, CSS that does not:

3. `.skills-tabs[role="tablist"]` has no rule, so the four tabs read as adjacent buttons with no
   active state. The controller already maintains `aria-selected` and `tabindex`
   (`apps/api/dashboard/dashboard.js:471-490`), so the state CSS needs is already in the DOM.
4. `#skill-detail` carries `class="drawer"`, which has no rule. `openSkillDetail()` sets
   `drawer.hidden = false` (`dashboard.js:1225-1228`) and the skeleton places it *inside* the library
   panel between the card list and the editor form, so it appears as a bare block in the page flow with
   four unlabelled containers, no heading naming the open skill, and no way to close it.
   `.drawer-close` is declared (`dashboard.css:476`) and is pinned by the contract test, but no element
   ever carries that class — the rule is dead.
5. Discover, Skill Sets, and Registry render bare flows with no panel framing, unlike every other
   dashboard page.

The requested outcome is a page that reads as one refined, intentional surface. The work is therefore
mostly a stylesheet and markup change; no API, route, schema, or runner operation is involved, and no
security-relevant surface is touched.

**Non-goals.** This plan does not add keyboard arrow-key navigation to the tablist (`role="tablist"`
without arrow keys is a real pre-existing gap, recorded as the only carry-over follow-up), and it does
not add the runner operations the docs say are missing for skill metadata edits, registry state
changes, or import submission.

## Current state, verified at `bd489d3`

| Fact | Evidence |
| --- | --- |
| Duplicate rows on desktop | `dashboard-render.js:905-906` emits table + `ul.card-grid`; `dashboard.css:600` hides only `.desktop-table`; `.card-grid` has no hiding rule |
| Cleaner pattern exists | `dashboard.css:329` `.mobile-list { display: none; }`; `dashboard-render.js:87, 1756, 1823, 1872` pair tables with `ul.mobile-list` |
| Toolbar and editor crammed | `dashboard.css:294` global `form` flex rule; `.skills-toolbar` and `#skill-editor` are both `<form>` |
| No page stylesheet | 7 Skills class names have 0 rules in `dashboard.css` (checked by selector count) |
| Tabs have no active state | `.skills-tabs` has no rule; `dashboard.js:477-480` already sets `aria-selected`/`tabindex` |
| Drawer is inline and undismissable | `dashboard.js:1225-1228`; `#skill-detail` sits inside the library panel in the skeleton; no `.drawer` rule; `.drawer-close` unreferenced |
| Contract ids are asserted | `apps/api/test/dashboard-ui-contract.test.ts:143-159` |
| Baseline is green | `npx vitest run` over `dashboard-skills-ui`, `dashboard-ui-contract`, `dashboard-design-tokens`, `dashboard-ui-behavior`, `dashboard-pages` → 130 passed |

## Goals

| # | Goal | Phase |
| --- | --- | --- |
| 1 | The library renders each row exactly once at every breakpoint, and shows one message when empty | 1 |
| 2 | The tab strip is readable and marks the active tab via `[aria-selected="true"]` | 2 |
| 3 | The filter bar is a labelled grid that wraps to columns on narrow viewports | 2 |
| 4 | The library body, bulk bar, and each non-library tab are framed as surfaces | 2, 4 |
| 5 | The detail panel is a framed drawer with a heading naming the open skill and a working close control | 3 |
| 6 | The create/edit form is a panel whose labels never share a baseline with an unrelated control | 3 |
| 7 | Empty and no-match library states are distinct and each offers the action that resolves it | 1 |
| 8 | Contracts, tests, and documentation stay in step | 5 |

## Phases

Each phase is a self-contained unit of work with its own success criteria and verification command.
The phase file owns the steps.

| Phase | Deliverable | File |
| --- | --- | --- |
| 1 | The library renders each row once at every breakpoint, and its empty and no-match states are honest | [`phase-01-library-visibility-and-states.md`](phase-01-library-visibility-and-states.md) |
| 2 | A readable tab strip with an unmistakable active tab, and a labelled filter grid that wraps | [`phase-02-tab-strip-and-filter-bar.md`](phase-02-tab-strip-and-filter-bar.md) |
| 3 | A detail panel that names the open skill and closes, and an editor form that reads as a form | [`phase-03-detail-panel-and-editor-form.md`](phase-03-detail-panel-and-editor-form.md) |
| 4 | The Discover, Skill Sets, and Registry panels are framed as sections | [`phase-04-remaining-panel-framing.md`](phase-04-remaining-panel-framing.md) |
| 5 | The four structural decisions are pinned by the contract test, and both documents match the page | [`phase-05-contracts-tests-and-docs.md`](phase-05-contracts-tests-and-docs.md) |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A CSS `display` rule defeats the `hidden` attribute on the new drawer or panels, so a hidden panel shows | Phase 2 step 3 and Phase 5 step 1 pin `[hidden]` guards in the contract test, following the `.command-surface[hidden]` precedent |
| The empty-state toggle hides rows on a slow or failed fetch, making a load error look like an empty library | The block is only reached after `rows` resolves; `enterSkillsTab` catches and routes failures to `showError`, which is unchanged |
| Wrapping filter controls in `.skills-field` breaks the `label for`/`id` association | Every id is preserved and the contract test still asserts each one; the wrapper is a `div` that does not affect label targeting |
| A new rule uses hex or `gradient(`, which the contract test rejects | Phase 5 verification runs the full gate, which includes that assertion |
| Repopulating the filter controls on an empty state would fire their `change` handlers and lose the operator's filter | The repaint sets `value` and the selectors directly from `rows`; no event is dispatched, and `Clear filters` is the only path that resets state on purpose |

## Acceptance criteria

See the checklist in [issue #257](https://github.com/bestagentkits/cloud-harness-mcp/issues/257).
This plan makes every box there true, with the one exception recorded as a non-goal: keyboard arrow-key
navigation for the tablist.
