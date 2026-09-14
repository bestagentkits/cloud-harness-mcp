---
phase: 4
title: "UI/UX audit and repair"
status: completed
priority: P1
effort: "6h"
dependencies: [1, 2, 3]
---

# Phase 4: UI/UX audit and repair

## Goal

The measured UI/UX defects in `apps/api/dashboard/` are repaired, and a test
locks the spacing scale and the focus contract so they cannot regress.

## Files to Create / Modify

- Modify: `apps/api/dashboard/dashboard.css`
- Modify: `apps/api/test/dashboard-ui-contract.test.ts` (additive assertions only)

## Background — the measured defect list

These were found by scanning the working tree, not by guessing. Each has a
before/after and a pass condition below.

| # | Defect | Evidence in the current tree |
| --- | --- | --- |
| X1 | Off-scale spacing token | `--space-5: 1.25rem` (20px) has **13 consumers** (14 occurrences across 12 lines, counting the declaration at `dashboard.css:37`). It is a multiple of 4px, but 20px is not a member of the marketing scale {4, 8, 12, 16, 24, 32, 48, 64, 96}, and it is the only declared step outside that set. |
| X2 | Focus indicator removed | `.knowledge-textarea { ... outline: none; }` (line ~434) removes the focus ring with no replacement. The editor pane is the Knowledge page's primary input. |
| X3 | Target below 24px | `.checkbox-label input { width: 1.25rem; height: 1.25rem; }` is 20px, under the WCAG 2.2 AA 24x24 CSS-pixel minimum. |
| X4 | Duplicated component rules | `.knowledge-nav-tabs`/`.mcp-nav-tabs` and `.knowledge-tab-btn`/`.mcp-tab-btn` are byte-identical pairs (lines 403-406 and 477-480) differing only by selector name. |
| X5 | One-off radius | `.lifecycle li::before { border-radius: 50%; }` bypasses the `--radius-*` scale while the identical circular dot in `.status::before` uses `var(--radius-pill)`. |
| X6 | Unused token | `--text-20` is declared and never referenced. |
| X7 | Dead rule | `.sticky-actions` has one declaration and zero consumers in `index.html` or any `dashboard*.js`. |
| X8 | Notation inconsistency | Hairline values mix `.1875rem` (no leading zero) with `0.125rem` (leading zero) for the same kind of sub-4px value. |
| X9 | Unstyled classes | A class scan finds `button`, `secondary`, `row-actions`, `permission-row`, `task-list`, `knowledge-card-preview`, and `accent-btn` used with no rule. Phase 3 fixed the ones bound to real markup; this phase re-runs the scan and triages whatever remains. |
| X10 | Elevation inconsistency | `.knowledge-graph-container` sat on `--canvas` inside a `--surface` panel, and `.graph-controls` carried a standalone shadow. Phase 2 addressed both; this phase verifies no other surface/elevation mismatch remains. |

Treat X10 as a verification item: confirm no `.panel`-descendant surface drops to
`--canvas`, and no non-floating element carries `--shadow-overlay`.

## Tasks & Steps

### Task 4.1 — Re-map the off-scale spacing token and remove it

- **Goal:** Every spacing value is on the marketing 4px rhythm, and `--space-5`
  no longer exists.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the 13
  `var(--space-5)` consumers, and the `--space-5` declaration in `:root`.
- **Steps:**
  1. Replace each `var(--space-5)` with the nearest on-scale step using this
     mapping, chosen so interior density is preserved and separation still reads:
     - `padding: var(--space-5)` on a container → `var(--space-4)`
       (`.metric`, `.panel`).
     - `margin-block: var(--space-5)` / `margin-block-start: var(--space-5)` →
       `var(--space-6)` (`.lifecycle`, `.environment-list`, `.dialog-actions`,
       `.danger-zone`, `.detail-actions`).
     - `padding-block-start: var(--space-5)` → `var(--space-4)` (`.detail-actions`,
       `.danger-zone`).
     - `gap: var(--space-2) var(--space-5)` → `var(--space-2) var(--space-6)`
       (`.facts`).
     - `padding: 0 0 var(--space-6) var(--space-5)` → `0 0 var(--space-6) var(--space-6)`
       (`.lifecycle li`).
     - `inset-block-end`/`inset-inline-end: var(--space-5)` → `var(--space-4)`,
       and `2 * var(--space-5)` → `2 * var(--space-4)` (`.toasts`).
     - `padding-inline-start: var(--space-5)` → `var(--space-6)`
       (`.mcp-gateway-card .page-note ul`).
  2. Delete the `--space-5: 1.25rem;` declaration from the `:root` block.
  3. Do not change any spacing value that is already a `--space-1/2/3/4/6/8/10/12`
     token or a sub-4px hairline.
- **Success criteria:** no occurrence of `--space-5` remains anywhere in the file.
- **Verify:** `grep -c -- '--space-5' apps/api/dashboard/dashboard.css` prints `0`
  and `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0.

### Task 4.2 — Restore focus visibility

- **Goal:** Every focusable control shows a visible focus indicator.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the
  `.knowledge-textarea` rule.
- **Steps:**
  1. Remove `outline: none;` from `.knowledge-textarea`.
  2. Because the textarea is `border: none` inside a bordered pane, the global
     `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }`
     would draw the ring outside the pane and be clipped by
     `.knowledge-editor-pane { overflow: hidden; }`. So also add
     `.knowledge-textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }`
     so the ring lands inside the editor pane, and
     `.knowledge-editor-pane:focus-within { border-color: var(--accent); }` so the
     pane itself signals focus.
  3. Grep the file for any other `outline: none` or `outline: 0`. There is none
     today; if the grep finds one, give it a replacement indicator rather than
     deleting the property blindly.
- **Success criteria:** no `outline: none` remains; the editor pane and textarea
  both signal focus.
- **Verify:** `grep -c 'outline: none' apps/api/dashboard/dashboard.css` prints
  `0` and `grep -c 'knowledge-textarea:focus-visible' apps/api/dashboard/dashboard.css`
  prints `1`.

### Task 4.3 — Fix the sub-24px target

- **Goal:** The checkbox target meets the WCAG 2.2 AA 24x24 minimum.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the
  `.checkbox-label input` rule.
- **Steps:**
  1. Change `width` and `height` from `1.25rem` to `1.5rem` (24px).
  2. Keep `min-height: auto`, `padding: 0`, `box-shadow: none`, and
     `accent-color: var(--accent)`.
  3. Keep `margin-block-start: var(--space-1)` so the checkbox still aligns with
     the first line of its label.
- **Success criteria:** the checkbox is 24px and still visually aligned.
- **Verify:** `grep -n 'checkbox-label input' apps/api/dashboard/dashboard.css`
  shows `1.5rem`.

### Task 4.4 — Consolidate the duplicated tab rules and one-off values

- **Goal:** One rule per shared concept; no one-off radius or unused token.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the
  `.knowledge-nav-tabs`, `.mcp-nav-tabs`, `.knowledge-tab-btn`, `.mcp-tab-btn`,
  `.lifecycle li::before`, and `:root` blocks.
- **Steps:**
  1. Merge the nav-tabs pair into one rule with a selector list
     `.knowledge-nav-tabs, .mcp-nav-tabs { ... }`, keeping the *superset* of the
     two declarations, which is `.mcp-nav-tabs`'s `flex-wrap: wrap`.
  2. Merge the tab-button pair into one rule with a selector list
     `.knowledge-tab-btn, .mcp-tab-btn { ... }`, and merge their `:hover` and
     `.active` variants the same way.
  3. Change `.lifecycle li::before` from `border-radius: 50%` to
     `border-radius: var(--radius-pill)`.
  4. Delete the `--text-20` declaration from `:root`. If a later phase wants a
     20px step it can be re-added with a consumer.
  5. Delete the `.sticky-actions` rule.
  6. Normalise the sub-4px hairline values so all of them use a leading zero:
     `padding: .1875rem var(--space-2)` → `padding: 0.1875rem var(--space-2)`,
     and the same for `.0625rem`. Do not change the numeric values.
- **Success criteria:** the tab pairs are single rules; `--text-20` and
  `.sticky-actions` are gone; all hairline values use a leading zero.
- **Verify:** `grep -c 'mcp-nav-tabs {' apps/api/dashboard/dashboard.css` prints
  `1` by matching the merged selector list, `grep -c -- '--text-20' apps/api/dashboard/dashboard.css`
  prints `0`, and `grep -c 'sticky-actions' apps/api/dashboard/dashboard.css`
  prints `0`.

### Task 4.5 — Triage the remaining unstyled classes

- **Goal:** Every class applied in markup is either styled or documented as an
  intentional behaviour hook, with **no behaviour or markup regression**.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css` and
  `apps/api/test/dashboard-ui-contract.test.ts` **only**. No file under
  `apps/api/dashboard/*.html` or `apps/api/dashboard/*.js` may change in this
  task. Those files hold the DOM contract, the exact-`class="..."` assertions at
  `apps/api/test/dashboard-ui-behavior.test.ts:500`, `:501`, and `:725`, the MCP
  `data-mcp-*` hooks asserted at
  `apps/api/test/mcp-servers-dashboard-ui.test.ts:140-147`, and the write-only
  secret reset at `dashboard.js:130-132`. A "fix it in the markup" instinct here
  is the one path in this plan that can break the DOM contract the plan claims
  not to touch.
- **Steps:**
  1. Re-run the class scan. Use this one-liner from the repository root, which
     collects classes from `class="..."` attributes, `classList.*` calls, and
     `className` assignments, then subtracts the classes defined in the
     stylesheet:

     ```bash
     cd apps/api/dashboard && node -e '
     const fs=require("fs");
     const css=fs.readFileSync("dashboard.css","utf8");
     const html=fs.readFileSync("index.html","utf8");
     const js=fs.readFileSync("dashboard.js","utf8")+fs.readFileSync("dashboard-render.js","utf8")+fs.readFileSync("dashboard-api.js","utf8");
     const defined=new Set(); for(const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);
     const used=new Set();
     for(const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c=>c&&used.add(c));
     for(const m of js.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).forEach(c=>{if(c&&/^[a-zA-Z][\w-]*$/.test(c))used.add(c);});
     for(const m of js.matchAll(/classList\.(?:add|toggle|remove|contains)\(([^)]*)\)/g)) for(const q of m[1].matchAll(/[\x27"]([a-zA-Z][\w-]*)[\x27"]/g)) used.add(q[1]);
     console.log([...used].filter(c=>!defined.has(c)).sort().join(", "));
     '
     ```

  2. **HARD CONSTRAINT — do not rename or remove any existing class.** An earlier
     draft of this plan instructed you to convert class-based selectors to
     `data-*` wiring. That instruction is withdrawn, because it breaks an
     existing test. `apps/api/test/dashboard-ui-behavior.test.ts:500` asserts
     `class="reconcile-installation"`, line 501 asserts
     `class="danger disconnect-installation"`, and line 725 asserts
     `class="rotate-global-secret-form`. Removing those classes fails the suite.
     The MCP controls are already `data-*` wired and asserted that way
     (`apps/api/test/mcp-servers-dashboard-ui.test.ts:140-147` asserts
     `data-mcp-edit`, `data-mcp-toggle`, `data-mcp-test`, `data-mcp-refresh`, and
     `data-mcp-delete`), so their `mcp-*` classes are redundant naming, not
     missing behaviour. Leave every class name exactly as it is.
  3. For each class the scan reports, make exactly one of two changes:
     - **Add a rule** in `dashboard.css` when the name is a real visual concept
       that currently renders unstyled. The confirmed cases are `button`,
       `secondary`, `row-actions`, `permission-row`, `task-list`,
       `knowledge-card-preview`, and `accent-btn`; Phase 3 already gave all seven
       a rule. If the scan still reports any of them, that is a **Phase 3 gap:**
       fix it in `apps/api/dashboard/dashboard.css` here, not in the markup.
     - **Leave it alone** when it is a JavaScript query hook, a JS interpolation
       placeholder, or a name that inherits all of its styling from a parent or a
       co-applied class.
  4. Record your per-class decision and its reason in the phase journal. Do not
     encode the triage list into the CSS as comments, and do not delete classes.
  5. Do not change any behaviour, route, payload, `data-*` hook, or `id`. Do not
     edit `index.html`, `dashboard.js`, or `dashboard-render.js`.
- **Success criteria:** every class the scan reports has a recorded decision, the
  seven confirmed-unstyled classes have rules, and no class name was renamed or
  removed and no markup or JavaScript file changed.
- **Verify:** re-run the scan one-liner and confirm the reported set contains no
  entry you marked "add a rule". Then
  `npx vitest run dashboard` exits 0, including
  `apps/api/test/dashboard-ui-behavior.test.ts`.

### Task 4.6 — Lock the spacing scale and focus contract with a test

- **Goal:** The 4px rhythm and the focus contract are asserted, not just fixed.
- **Target files and symbols:** `apps/api/test/dashboard-ui-contract.test.ts`.
- **Steps:**
  1. Add a test case named `'keeps every spacing step on the marketing 4px rhythm'`.
  2. Read `dashboard.css`, extract every `--space-N: <value>rem;` declaration,
     convert each to 4px base units, and assert each is a whole number. Then
     assert the sorted set of steps equals `[1, 2, 3, 4, 6, 8, 10, 12]`. The
     set-equality assertion is the one that matters: 20px is itself a whole
     number of 4px units, so the whole-number check alone would still pass with
     `--space-5` present. Do not drop the set assertion.
  3. Add a test case named `'never removes a focus indicator without a replacement'`
     asserting that `css` contains neither `'outline: none'` nor `'outline: 0'`.
  4. Add a test case named `'keeps the interactive target floor at 24px'` asserting
     that `css` does not contain `'width: 1.25rem; height: 1.25rem'` on the
     checkbox rule. Read the `.checkbox-label input` declaration block and assert
     it contains `1.5rem`.
  5. Do not duplicate assertions already made by
     `apps/api/test/dashboard-design-tokens.test.ts`.
- **Success criteria:** the three new cases exist and pass.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0
  and the output lists the three new case names.

## Verification

- `npx vitest run dashboard` exits 0. This glob is deliberate: it matches every
  test file whose path contains `dashboard` — ten files today, plus the new
  `dashboard-design-tokens.test.ts`. That includes
  `apps/api/test/dashboard-ui-behavior.test.ts`,
  `apps/api/test/knowledge-dashboard-ui.test.ts`, and
  `apps/api/test/mcp-servers-dashboard-ui.test.ts`, all three of which a
  `dashboard-*.test.ts` pattern silently misses.
- `grep -cE '#[0-9a-f]{3,8}' apps/api/dashboard/dashboard.css` prints `0`.
- `grep -c 'gradient(' apps/api/dashboard/dashboard.css` prints `0`.
- `grep -c -- '--space-5' apps/api/dashboard/dashboard.css` prints `0`.
- `grep -c 'outline: none' apps/api/dashboard/dashboard.css` prints `0`.
- `npm run lint` and `npm run typecheck` exit 0.

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
