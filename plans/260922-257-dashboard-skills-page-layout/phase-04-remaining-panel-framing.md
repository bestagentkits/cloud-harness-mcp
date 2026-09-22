---
phase: 4
title: "Frame the Discover, Skill Sets, and Registry panels"
status: completed
priority: P2
effort: "2-3h"
dependencies: [3]
---

# Phase 4: Remaining tab framing

## Goal

Every tab panel reads as framed sections rather than a bare flow, and the set builder presents its
picker as a bounded control.

## Evidence

- Discover renders `<div class="skills-search">` and `<div id="skills-search-results">` with no rules
  anywhere: `.skills-search` has zero CSS.
- `#skill-set-builder` is an unstyled `<div>` holding a label+input, `#skill-set-picker`,
  `<ol id="skill-set-members">`, a save button, and `#skill-set-status` — all in plain block flow.
- Registry renders `<table id="skills-registry-table">`, `<h3>Suggested toolkits to install</h3>`, and
  `<ul id="skills-registry-suggestions">` directly on the canvas with no panel framing.
- `.skills-revisions` (produced by `renderSkillRevisions`, used inside the Phase 3 panel) and
  `.skills-diff` (a `<pre>` for the revision diff) have zero rules.

## Tasks

1. Wrap the Discover search row and its result area in `.panel` sections with headings. Add
   `.skills-search { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-3); }` with the
   input flexing to fill the row.
2. Give `#skill-set-builder` a form grid: the name field full width, `#skill-set-picker` as a bounded
   scrollable checkbox grid reusing the `.tools-checkbox-grid` language (`dashboard.css:474`),
   `#skill-set-members` as a numbered list with a hairline between rows, and the save button with
   `#skill-set-status` in a footer row.
3. Frame the registry table and the suggestions list in `.panel` sections, and style
   `.skills-revisions` as a row list: the id in mono, the origin muted, the timestamp right-aligned, and
   the restore/diff/fork cluster using the existing `.row-actions` language
   (`dashboard.css:672`).
4. `.skills-diff` is already a `<pre>`, so it inherits the code treatment. Add only a bounded
   `max-height` and `overflow: auto`, matching the audit list's `pre` rule
   (`dashboard.css:406`), so a long diff cannot push the page open.

## Constraints

- Reuse existing component language (`.panel`, `.tools-checkbox-grid`, `.row-actions`, `.empty`). Do not
  introduce a parallel set of container class names for the same visual job.
- The registry suggestions list is rendered as text nodes by `skillPresetNodes`
  (`dashboard.js:1175-1183`), so the styling must work on a plain `<li>` with no child elements.

## Success criteria

- Every tab panel has at least one framed section and a heading.
- The set picker is a bounded scroll area rather than an unbounded checkbox column.
- A long revision diff scrolls inside its own box instead of growing the page.

## Verification

```bash
npx vitest run apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-design-tokens.test.ts
npm run lint
```

## Follow-up

Keyboard arrow-key navigation for the tablist is **out of scope**. `role="tablist"` with `tabindex`
management implies arrow-key support, and this page does not implement it. It is a real gap, invisible
in the reported screenshot, and recorded in the final report as the only carry-over item from issue #257.
