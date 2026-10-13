---
phase: 2
title: "Theme icon control"
status: pending
priority: P1
effort: "2h"
dependencies: [1]
---

# Phase 2: Theme icon control

## Goal

The three-button `System / Light / Dark` group in the top bar becomes a single
cycling icon control that still exposes all three states, still persists the
choice server-side, and still announces the change.

## Context Links

- `apps/api/dashboard/index.html:18-23` — the `.theme-control` group being replaced
- `apps/api/dashboard/dashboard.js:1394-1405` — the binding being replaced
- `apps/api/dashboard/dashboard.css:174-178,471` — the rules being deleted
- `apps/api/src/dashboard-router.ts:96-107` — `PUT /api/v1/preferences`
- `docs/design-guidelines.md` — adaptive dark theme, interaction-state requirements

## Key Insights

- **`aria-pressed` is wrong here.** It is a two-state attribute; this control has
  three states. Putting `aria-pressed` on a tri-state cycler is a real and
  misleading accessibility bug. The accessible name carries the state instead.
- **The popover alternative is not implementable cheaply.** `style-src 'self'`
  with no `'unsafe-inline'` (`apps/api/src/dashboard-security.ts:29`) blocks
  inline `style` attributes, so a JS-positioned dropdown cannot be positioned at
  all; it would require a CSS-only anchored menu. That is a large new widget for
  a control touched once per user lifetime.
- **The existing contract assertions can survive unweakened.** They assert only
  the three literal substrings `data-theme-value="system"`, `"light"`, `"dark"`
  in `index.html` — not a button count or a `role="group"`. Keeping those
  literals on the three state icons *inside* the single button keeps the
  attribute load-bearing (it drives the state machine and icon swap) instead of
  becoming a fossil left to appease a test.
- The server already injects `html[data-theme]` on first paint from the
  `ch-dashboard-theme` cookie, so the client only reads
  `document.documentElement.dataset.theme`; there is no flash-of-wrong-theme to
  solve here.

## Requirements

- Functional: one visible icon control cycles `system → light → dark → system`.
- Functional: clicking applies the theme immediately and persists it via
  `PUT /api/v1/preferences` with the exact value `system | light | dark`.
- Functional: the icon shown matches the active state on load, including when
  the server forced the theme from the cookie.
- Functional: `announce()` reports the new theme.
- Accessibility: the accessible name states the current state and the next
  action; the attribute is rewritten on every press.
- Accessibility: keyboard-operable as a native `<button>`; never `aria-pressed`.
- Non-functional: no `element.style` mutation — CSP blocks inline style
  attributes. Use `hidden` and `classList` only.
- Non-functional: `min-height: 2.75rem` touch target preserved via `.icon-btn`.

## Architecture

```
click ──> nextTheme(current) ──> apply to document.documentElement.dataset.theme
                              ├─> swap which icon inside #theme-toggle is visible
                              ├─> rewrite aria-label
                              ├─> announce(...)
                              └─> PUT /api/v1/preferences { theme }
```

State lives in the DOM only (`document.documentElement.dataset.theme`), matching
the existing design. `system` is represented by **removing** the attribute, which
is what re-enables the `@media (prefers-color-scheme: dark)` block.

## Related Code Files

- Modify: `apps/api/dashboard/index.html`
- Modify: `apps/api/dashboard/dashboard.css`
- Modify: `apps/api/dashboard/dashboard.js`
- Modify: `apps/api/test/dashboard-ui-contract.test.ts`
- Modify: `apps/api/test/dashboard-ui-behavior.test.ts`

## Implementation Steps

### Task 2.1 — Markup: one button, three state icons

- **Goal:** `#theme-toggle` replaces `.theme-control`.
- **Target files and symbols:** `apps/api/dashboard/index.html`, the
  `<div class="theme-control" role="group" aria-label="Theme">` block (lines
  19-23) inside `.topbar-right`.
- **Steps:**
  1. Delete the whole `.theme-control` div.
  2. In its place, insert a single `<button id="theme-toggle" class="icon-btn theme-toggle" type="button" aria-label="Theme: system. Activate to switch to light.">`.
  3. Inside the button place exactly three inline SVGs, each carrying
     `data-theme-value="system" | "light" | "dark"` and `aria-hidden="true"`.
     The `system` icon is visible; `light` and `dark` carry the `hidden`
     attribute.
  4. Draw the three icons at `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`,
     matching every other icon in the file: a monitor (system), a sun (light),
     a moon (dark).
  5. Do not add `role="group"`, `aria-pressed`, or a `title` attribute.
- **Success criteria:** the three `data-theme-value` literal substrings still
  exist in `index.html`; exactly one `<button id="theme-toggle"` exists; no
  `.theme-control` remains.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0
  after Task 2.4's additions.

### Task 2.2 — Pure theme state machine

- **Goal:** the cycle order and the accessible label are testable pure
  functions.
- **Target files and symbols:** `apps/api/dashboard/dashboard.js` — add exported
  `THEME_ORDER`, `nextTheme(current)`, and `themeActionLabel(current)`.
- **Steps:**
  1. Add `export const THEME_ORDER = ['system', 'light', 'dark'];` near the other
     module-level constants.
  2. Add `export function nextTheme(current)` returning the successor of
     `current` in `THEME_ORDER`, wrapping `dark → system`, and treating an
     unknown input as `system` (so its successor is `light`).
  3. Add `export function themeActionLabel(current)` returning
     `` `Theme: ${resolved}. Activate to switch to ${nextTheme(resolved)}.` ``
     using the same unknown-input fallback.
  4. Keep both functions free of DOM access so the no-jsdom behavior suite can
     exercise them.
- **Success criteria:** both functions are exported and DOM-free.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts` exits 0
  after Task 2.5's cases.

### Task 2.3 — Wire the control

- **Goal:** clicking cycles, applies, persists, and announces.
- **Target files and symbols:** `apps/api/dashboard/dashboard.js:1394-1405` — the
  whole `const themeControl = …` block.
- **Steps:**
  1. Delete the `themeControl` loop entirely.
  2. Query `#theme-toggle` and its three `svg[data-theme-value]` children.
  3. Add `function renderThemeToggle()` (inside `initializeDashboard`) that reads
     `document.documentElement.dataset.theme ?? 'system'`, sets the `hidden`
     attribute on each icon so only the active one is visible, and sets the
     button's `aria-label` from `themeActionLabel(active)`.
  4. Add a `click` listener: `const value = nextTheme(document.documentElement.dataset.theme ?? 'system')`; if `value === 'system'` delete
     `document.documentElement.dataset.theme`, else assign it; call
     `renderThemeToggle()`; `announce(\`Theme set to ${value}.\`)`; then
     `void api('/preferences', { method: 'PUT', body: requestBody({ theme: value }) }).catch(() => announce('Theme preference was not saved.'))`.
  5. Call `renderThemeToggle()` once during boot so the initial icon matches a
     server-forced theme.
  6. Use `hidden` and `classList` only — never `element.style`.
- **Success criteria:** the old `.theme-opt` loop no longer exists; the new
  binding posts the same payload shape to the same endpoint.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0
  and the contract suite still finds `api('/preferences'` in the script.

### Task 2.4 — Delete the dead CSS

- **Goal:** no orphaned `.theme-control` / `.theme-opt` rules remain.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css` — lines
  174-178 (`.theme-control`, `.theme-opt`, `.theme-opt + .theme-opt`,
  `.theme-opt:hover:not(:disabled)`, `.theme-opt[aria-pressed="true"]`) and the
  `@media (max-width: 48rem)` override `.theme-opt { padding-inline: var(--space-2); }`
  at line 471.
- **Steps:**
  1. Delete all five `.theme-control` / `.theme-opt` rules.
  2. Delete the mobile `.theme-opt` override.
  3. Add `.theme-toggle svg[hidden] { display: none; }` so a `hidden` icon is
     never painted even if a later rule sets a display value on `svg`.
  4. Do not touch `.icon-btn` (lines 169-171) — the touch target requirement
     depends on it.
- **Success criteria:** the strings `theme-control` and `theme-opt` do not appear
  in `apps/api/dashboard/dashboard.css`.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0
  and still asserts `min-height: 2.75rem` and `.app-shell.nav-collapsed`.

### Task 2.5 — Tests first: cycle behavior and strengthened contract

- **Goal:** the tri-state cycle is covered and the contract test describes the
  control that actually exists.
- **Target files and symbols:**
  `apps/api/test/dashboard-ui-behavior.test.ts` — new cases importing
  `nextTheme`, `themeActionLabel`, `THEME_ORDER` from
  `../dashboard/dashboard.js`;
  `apps/api/test/dashboard-ui-contract.test.ts` — the theme case at the
  `provides a top header …` test.
- **Steps (red phase first):**
  1. In the behavior suite add: the cycle order is
     `system → light → dark → system`; an unknown input resolves to `system`
     before stepping; `themeActionLabel('dark')` names both the current state and
     the next action.
  2. In the contract suite **keep** the existing three `data-theme-value`
     assertions unchanged, then **add** `id="theme-toggle"`,
     `class="icon-btn theme-toggle"`, `aria-keyshortcuts` absence on this
     control, and a `Theme:` prefix assertion on the `aria-label`.
  3. Add a negative assertion that `aria-pressed` does not appear inside the
     `#theme-toggle` button markup.
  4. Run the behavior suite before Task 2.2 lands and confirm it fails on the
     missing exports. This red state is expected.
- **Success criteria:** theme coverage after the diff is strictly larger than
  before; the three original literals are still asserted.
- **Verify:**
  - Red: `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts` exits
    non-zero (missing export `nextTheme`).
  - Green: `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts apps/api/test/dashboard-ui-contract.test.ts` exits 0.

## Tests Before (TDD)

- Behavior: cycle order, unknown-input fallback, and label content — pure
  functions, no DOM needed.
- Contract: the existing three literals stay asserted; the new control shape is
  asserted additionally; `aria-pressed` is asserted absent.
- Regression gate: `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts apps/api/test/dashboard-ui-contract.test.ts`

## Tests After (TDD)

No additional tests. The tri-state cycle, the label, and the markup contract are
the complete observable surface; DOM click handling cannot be exercised in this
suite because there is no jsdom and the harness is a hand-rolled fake element.

## Refactor

- Deletes `.theme-control` / `.theme-opt` CSS and the mobile override rather than
  leaving them orphaned.
- Replaces the three-listener loop with one listener plus a pure state machine.

## Todo

- [ ] Task 2.5 (red): failing cycle + contract assertions
- [ ] Task 2.1: `#theme-toggle` markup with three state icons
- [ ] Task 2.2: `THEME_ORDER` / `nextTheme` / `themeActionLabel`
- [ ] Task 2.3: wire the cycle, persistence, and announcement
- [ ] Task 2.4: delete dead theme CSS
- [ ] Verify green: contract + behavior suites

## Success Criteria

- One icon control in the top bar; three presses traverse
  `system → light → dark → system`.
- Selecting `system` removes `html[data-theme]` so `prefers-color-scheme` governs.
- `PUT /api/v1/preferences` receives `{ theme }` for the chosen state.
- `theme-control` and `theme-opt` appear nowhere in the dashboard assets.
- Coverage of the theme control is strictly larger than before the change.

## Risk Assessment

- **Risk (highest-value artifact in review):** deleting the three
  `data-theme-value` assertions instead of preserving them, silently dropping
  coverage. **Mitigation:** the markup keeps the literals as load-bearing icon
  attributes, so deletion is unnecessary and the assertions stay byte-identical.
- **Risk:** `aria-pressed` is re-added out of habit, mis-describing a tri-state
  control. **Mitigation:** Task 2.5 adds a negative assertion for it.
- **Risk:** the icon does not match a server-forced theme on first paint.
  **Mitigation:** `renderThemeToggle()` runs at boot reading the DOM attribute
  the server injected.

## Security Considerations

- No new data flow. The control calls the existing CSRF-guarded
  `PUT /api/v1/preferences`, unchanged.
- No inline styles, no client storage — both forbidden by the CSP and the
  contract test.
- The theme value is drawn from a fixed three-element list, never from user text,
  so no escaping concern arises.

## Next Steps

Proceed to Phase 3 (command palette), which edits the same top bar to add the
palette trigger.

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
