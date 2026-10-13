---
phase: 3
title: "Component reskin"
status: completed
priority: P1
effort: "5h"
dependencies: [1, 2]
---

# Phase 3: Component reskin

## Goal

Every interactive component — buttons, inputs, selects, textareas, tables,
dialogs, tabs, pills, toasts, skeletons, cards, and the n  -avigation shell —
renders in the HUD system with a complete default / hover / focus-visible /
active / disabled state set.

## Files to Create / Modify

- Modify: `apps/api/dashboard/dashboard.css` (control base, button rules,
  `/* Toolbar */`, `/* Shell */`, `/* Top header */`, `/* Command palette */`,
  `/* Detail drawer */`, `/* Callouts */`, `/* Dialogs */`, `/* Toasts */`,
  `/* Skeleton loading */`, knowledge and MCP sections)
- Modify: `apps/api/dashboard/dashboard.js` only if a class name must change; no
  behavior change is authorised in this phase.

## Background the executor needs

The shell markup in `apps/api/dashboard/index.html` is a contract. Do not add,
remove, or rename elements, `id`s, `aria-*` attributes, or landmarks.

Three classes are applied in the markup and in `dashboard-render.js` but have
**no CSS rule at all**. This phase gives them real styling:

- `accent-btn` — 7 uses in `index.html`, 4 in `dashboard-render.js`. It marks the
  primary call to action. Because `#open-workspace-btn` is `type="button"`, it
  currently receives no primary styling at all; only the `type="submit"` uses
  accidentally pick up the submit rule. Land this properly with an explicit rule
  and delete the positional `button[type="submit"]:not(.danger)` primary rule so
  there is exactly one way to express "primary".
- `button` + `secondary` — used together on the Download link in
  `dashboard-render.js` (`<a class="secondary button download-artifact">`). A
  link styled as a button currently renders as body text.
- `row-actions` — used in `dashboard-render.js` for button clusters inside
  `.record-heading`. Without a rule the cluster relies on inherited flex wrapping
  only.

## Tasks & Steps

### Task 3.1 — One explicit primary button style, without demoting any submit

- **Goal:** `accent-btn` becomes a real, explicit primary control that works on
  `<button>` and `<a>` — **added alongside** the existing submit rule, not
  replacing it.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css` (the
  `button[type="submit"]:not(.danger)` rules at lines 127-131 and a new
  `.accent-btn` rule), plus two one-line markup fixes in
  `apps/api/dashboard/index.html` and `apps/api/dashboard/dashboard-render.js`.
- **Steps:**
  1. **Do NOT delete the `button[type="submit"]:not(.danger)` rules at lines
     127-131.** An earlier draft of this plan instructed you to delete them. That
     instruction is withdrawn, and here is the evidence: roughly twenty
     `<button type="submit">` controls in this codebase carry no class at all,
     for example `index.html:53` `<button type="submit">Apply filters</button>`,
     `index.html:94` `<button type="submit" id="submit-bulk-import">Apply import</button>`,
     `dashboard-render.js:848` `<button type="submit">Save permissions</button>`,
     and the create/save forms throughout `dashboard-render.js`. Deleting the
     positional rule would silently demote every one of them to the neutral
     control base, which for `#submit-bulk-import` and `Save permissions` would
     make a privileged confirmation look identical to the adjacent Cancel button.
     The positional rule stays as the default primary for form submits.
  2. **Add** a `.accent-btn` rule as an explicit primary that wins for the cases
     the positional rule cannot reach: `type="button"` controls and anchors.
     Give it the same declarations as the submit rule
     (`background: var(--accent); border-color: var(--accent); color: var(--on-accent);`)
     plus the matching `:hover:not(:disabled)` and `:active:not(:disabled)`, and
     place it **after** the submit rules so it wins when both apply.
  3. Add `.accent-btn` to the shared control base selector list so it inherits
     `min-height: 2.75rem`, `border: 1px solid var(--line-strong)`,
     `border-radius: var(--radius-sm)`, `font: inherit`, and the transition. Add
     `display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); text-decoration: none;`
     so an anchor rendered with this class is centred like a button.
  4. Add `class="accent-btn"` to the two privilege-relevant submits that have no
     class, so their primary intent is explicit rather than positional:
     `index.html:94`'s `#submit-bulk-import` (writes and rotates secret values via
     `POST /secrets/bulk`) and the `Save permissions` button in
     `dashboard-render.js:848` (rewrites the gateway's per-tool allow/deny set).
     These are one-attribute additions; do not change any other attribute, `id`,
     or text.
  5. Add `.button` and `.secondary` rules so the artifact Download link
     (`dashboard-render.js:56`, `<a class="secondary button download-artifact">`)
     becomes a real secondary control: `display: inline-flex; align-items: center; min-height: 2.75rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); text-decoration: none; font-weight: 600; font-size: var(--text-13);`,
     with `:hover` switching to `--accent` border and `--accent-strong` text.
  6. Fix the broken href on that same anchor in `dashboard-render.js:56`. It
     currently renders `href="/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/download"`,
     but `registerDashboardControlRoutes` registers the route as
     `/api/v1/artifacts/:artifactId/download` on a router mounted at `/dashboard`
     (`apps/api/src/app.ts:77`). The real path is therefore
     `/dashboard/api/v1/artifacts/:artifactId/download`, which is also the base
     `dashboard-api.js:10` uses. There is no `/api/v1` mount and no ingress
     rewrite (`deploy/nginx/cloud-harness-mcp.conf` has only `/mcp`,
     `/mcp-gateway`, `/mcp-api-key`, `/dashboard`, and `^~ /dashboard/`), and no
     JavaScript click handler intercepts the link. So the current Download control
     returns 404. Change the href to
     `href="/dashboard/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/download"`.
     This is the only `href` change authorised in this plan; leave the `download`
     attribute and the `Delete` button untouched.
- **Success criteria:** the `button[type="submit"]:not(.danger)` rules still
  exist; `.accent-btn`, `.button`, and `.secondary` each have a rule;
  `#submit-bulk-import` and the `Save permissions` button carry
  `class="accent-btn"`; the artifact Download href is prefixed with `/dashboard`.
- **Verify:**

  ```bash
  grep -c 'button\[type="submit"\]' apps/api/dashboard/dashboard.css
  grep -c '\.accent-btn' apps/api/dashboard/dashboard.css
  grep -c 'class="accent-btn"' apps/api/dashboard/index.html
  grep -c 'href="/dashboard/api/v1/artifacts' apps/api/dashboard/dashboard-render.js
  ```

  print `3` (not `0`), at least `3`, at least `3`, and `1` respectively. Then
  `npx vitest run dashboard` exits 0.

### Task 3.2 — Control base and interaction states

- **Goal:** Every control ships default / hover / focus-visible / active /
  disabled, and inputs never render below 16px on a narrow viewport.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the
  `button, input, select, textarea` base rule, the `:focus-visible` rule, and the
  `.knowledge-filters` rule.
- **Steps:**
  1. Keep the control base's `min-height: 2.75rem`, `border: 1px solid var(--line-strong)`,
     `border-radius: var(--radius-sm)`, `background: var(--surface)`,
     `color: var(--ink)`, `font: inherit`, and the four-property transition.
     Do not use `transition: all`; the design guidelines and this plan forbid it.
  2. Keep the inset `--shadow-raise` on `input, select, textarea` only. Buttons
     must not carry an inset shadow.
  3. Keep `input:focus, select:focus, textarea:focus { border-color: var(--accent); }`
     and the global `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }`.
  4. Change `.knowledge-filters select, .knowledge-filters input` so the
     `font-size` is `var(--text-16)` instead of `var(--text-13)`. Keep the
     `--space-1`/`--space-2` padding and the `--line` border. This fixes the
     sub-16px input text that the design guidelines forbid and that triggers
     mobile zoom.
  5. Add an explicit disabled treatment for `.accent-btn:disabled`,
     `.accent-btn[aria-disabled="true"]`, `.button:disabled`, and `a.button[aria-disabled="true"]`
     that keeps `--accent` but applies `opacity: .5; cursor: not-allowed;` and no
     hover transform.
- **Success criteria:** the filters input font-size is `--text-16`; disabled
  states exist for the primary and secondary controls.
- **Verify:** `grep -n 'knowledge-filters select' apps/api/dashboard/dashboard.css`
  shows `font-size: var(--text-16)`, and
  `grep -c 'cursor: not-allowed' apps/api/dashboard/dashboard.css` prints at least `2`.

### Task 3.3 — Shell, header, and navigation

- **Goal:** The top bar and rail read as the HUD chrome.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the `.topbar`,
  `.brand`, `.env-tag`, `.icon-btn`, `.profile-chip`, `.avatar`,
  `.sidebar`, `.nav-group`, `.sidebar nav a`, `.sidebar-version`,
  `.site-footer` rules.
- **Steps:**
  1. Give `.topbar` `border-block-end: 1px solid var(--line-soft)`-equivalent by
     using `var(--line)` (the token layer's soft value) and keep
     `background: var(--surface)`. Do not add `backdrop-filter` or a translucent
     background; the marketing header uses `backdrop-filter: blur()` with a
     semi-transparent fill, which the dashboard cannot pair with a solid
     `--surface` without doubling the declaration. Choose the solid surface.
  2. Keep `.brand` uppercase with `letter-spacing: .06em` and add
     `font-weight: 800`.
  3. Keep `.brand::before` as a square mark but change `border-radius` to
     `var(--radius-sm)` and set `background: var(--accent)` with
     `box-shadow: inset 0 0 0 .1875rem var(--accent-soft)`.
  4. Keep `.env-tag` mono, uppercase, `letter-spacing: .12em`, and set its colour
     to `var(--accent-strong)`.
  5. Keep `.sidebar` at `1px solid var(--line)` on the inline end, and keep the
     exact contract substring
     `.sidebar { position: sticky; inset-block-start: 3.5rem; height: calc(100dvh - 3.5rem); overflow: hidden;`
     and the exact substring
     `.sidebar nav { display: grid; gap: var(--space-1); align-content: start; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }`.
     The contract test asserts both verbatim.
  6. Keep `.sidebar nav a[aria-current]::before` as the active rail, now cyan
     through `var(--accent)`, and keep `.sidebar nav a[aria-current]` at
     `background: var(--accent-soft)`.
  7. Keep `.site-footer` mono and muted, and keep the anchor at
     `var(--accent-strong)`.
- **Success criteria:** the brand mark uses `--radius-sm` and `--accent`; the
  `.env-tag` uses `--accent-strong`; the two contract substrings are unchanged.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts`
  exits 0.

### Task 3.4 — Dialogs, toasts, skeletons, and record components

- **Goal:** Floating layers and async states are consistent with the HUD.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, `dialog`,
  `dialog::backdrop`, `.dialog-actions`, `.toast`, `.skeleton`,
  `.card-grid li.panel`, `.record-heading`, `.row-actions`, `.permission-row`,
  `.task-list`, `.knowledge-card-preview` rules.
- **Steps:**
  1. Keep `dialog` on `--surface`, `1px solid var(--line-strong)`,
     `--radius-lg`, and `--shadow-overlay`. Tokenize `dialog::backdrop` from its
     raw literal to `oklch(0 0 0 / .66)` in the dark base.
  2. Add the light backdrop as **two separate top-level rules**, never nested
     inside a token block:
     `:root[data-theme="light"] dialog::backdrop { background: oklch(0.35 0.03 260 / .45); }`
     as its own rule, and
     `:root:not([data-theme]) dialog::backdrop { background: oklch(0.35 0.03 260 / .45); }`
     placed inside the existing `@media (prefers-color-scheme: light)` block but as
     a separate rule alongside the token block, not inside it. Do **not** nest a
     rule inside the `:root[data-theme="light"]` token block or inside the
     `@media (prefers-color-scheme: light)` token block: the block extractor in
     `apps/api/test/dashboard-design-tokens.test.ts` matches `\{([^}]*)\}`, so a
     nested rule would truncate the block at the nested closing brace and silently
     drop the remaining token declarations from the parsed and comparison sets.
  3. Keep `.toast` on `--surface-raised` with `--shadow-overlay` and the
     `border-inline-start-width: .1875rem` accent bar. Keep `.toast.success` at
     `--success` and `.toast.error` at `--danger`.
  4. **Do not add `.toast.info`.** `dashboard.js:621` defines
     `function toast(message, kind = '')` and the only call site is
     `toast(message)` at `:620`, so no caller ever passes a kind. An `info` toast
     would be unreachable. Note in your journal that `.toast.success` and
     `.toast.error` are unreachable today for the same reason; this plan does not
     fix that, because wiring toast kinds is a behaviour change.
  5. Keep `.skeleton` on `--surface-muted` with `1px solid var(--line)` and the
     `skeleton-pulse` animation; confirm the `prefers-reduced-motion` block
     still neutralises it.
  6. Add a new `.row-actions` rule:
     `display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; justify-content: flex-end;`
     so record action clusters wrap instead of overflowing.
  7. Add a new `.permission-row` rule so the MCP per-tool list lays out as a
     label/select row: `display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: var(--space-3); align-items: center; padding-block: var(--space-2); border-block-start: 1px solid var(--line);`
     with `.permission-row:first-child { border-block-start: none; }`.
  8. Add a new `.task-list` rule matching the existing list grammar:
     `list-style: none; padding: 0; margin: 0; display: grid; gap: var(--space-2);`
     with `.task-list li` at `padding: var(--space-2) 0; border-block-start: 1px solid var(--line);`
     and no border on the first child.
  9. Add a new `.knowledge-card-preview` rule:
     `color: var(--ink-muted); font-size: var(--text-13); overflow-wrap: anywhere;`
  10. Keep `.empty` on `--surface` with a dashed `--line-strong` border and
      `--radius-md`.
- **Success criteria:** `.row-actions`, `.permission-row`, `.task-list`, and
  `.knowledge-card-preview` each have a rule; the light backdrop is two separate
  top-level rules; no `.toast.info` rule is added.
- **Verify:**

  ```bash
  for c in row-actions permission-row task-list knowledge-card-preview; do grep -c "\.$c" apps/api/dashboard/dashboard.css; done
  grep -c 'dialog::backdrop' apps/api/dashboard/dashboard.css
  grep -c 'toast.info' apps/api/dashboard/dashboard.css
  ```

  print four numbers each at least `1`, `3` (base plus the two light rules), and
  `0` respectively. Then `npx vitest run dashboard` exits 0.

## Verification

- `npx vitest run dashboard` exits 0. That glob covers all five dashboard UI
  suites. `dashboard-ui-behavior.test.ts` in particular renders this file's
  components and asserts the produced markup, so it is the real guard against a
  component reskin breaking a template.
- `grep -c 'transition: all' apps/api/dashboard/dashboard.css` prints `0`.
- `grep -cE '#[0-9a-f]{3,8}' apps/api/dashboard/dashboard.css` prints `0`.
- `grep -c 'gradient(' apps/api/dashboard/dashboard.css` prints `0`.
- `npm run lint` exits 0.

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
