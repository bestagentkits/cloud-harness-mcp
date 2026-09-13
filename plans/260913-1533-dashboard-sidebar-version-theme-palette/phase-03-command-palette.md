---
phase: 3
title: "CMD+K command palette"
status: pending
priority: P1
effort: "8h"
dependencies: [2]
---

# Phase 3: CMD+K command palette

## Goal

`CMD+K` / `CTRL+K` opens a keyboard-driven palette that searches workspaces,
projects, global secrets, API keys, model credentials and profiles, and
artifacts, plus every dashboard page, and navigates on Enter. A visible top-bar
button opens the same palette for pointer and touch users.

## Context Links

- `apps/api/dashboard/dashboard.js:392-411` — the `load()` pathname dispatch
- `apps/api/dashboard/dashboard.js:417-419,1406` — page-load requests that share the concurrency budget
- `apps/api/dashboard/dashboard-render.js:1` — the local `escape` helper
- `apps/api/src/request-security.ts:45-48,88` — the per-principal limiter (120/min, **8 concurrent**)
- `apps/api/src/dashboard-response.ts:73,137` — why `/knowledge` is excluded (full `content` in the list response)
- `apps/api/src/dashboard-security.ts:29` — `style-src 'self'`, no `'unsafe-inline'`
- `apps/api/test/dashboard-ui-behavior.test.ts:1-27` — the no-jsdom `FakeElement` harness

## Key Insights

- **Client-side fan-out is the security-correct choice.** The existing list
  endpoints already carry per-principal scoping and answer with an allowlisted
  projection. A new `GET /api/v1/search` would have to re-derive authorization
  across seven resource types; drift between the search path and the list path is
  a data-leak bug class that cannot exist in the fan-out design.
- **The concurrency budget is the binding constraint, not the request rate.**
  `principalRequestLimits` rejects with `429` when `active >= 8`
  (`apps/api/src/request-security.ts:45-48,88`, applied to all `/dashboard`
  traffic at `apps/api/src/app.ts:46`). Page load already spends six requests at
  `dashboard.js:417-419` plus an independent `/profile` at `:1406`. An
  eight-wide palette fan-out can therefore be throttled by nothing more than a
  user pressing `CMD+K` during load, and `Promise.allSettled` would silently
  freeze the throttled sources as empty. The fan-out must be **batched** and must
  **never cache a failure as an empty source**.
- **A rejected source must stay retryable.** `Promise.allSettled` returns
  `rejected` for a `429` exactly as it does for a genuinely missing resource.
  Treating both as "empty" is a correctness bug; a `429` is transient.
- **`GET /knowledge` is not a metadata endpoint.** Its list response includes each
  item's full `content` (`apps/api/src/dashboard-response.ts:73,137`) and the
  schema permits 262 144 characters per item
  (`packages/contracts/src/knowledge-schemas.ts:33`). Fetching 100 items could
  transfer ~26 MB for a navigation palette, and the 200/1000 caps apply only
  *after* download. Knowledge is therefore **excluded**; the palette offers a
  static Knowledge page command, and the Knowledge page already has real search
  (`POST /api/v1/knowledge/search`).
- **Secret descriptions are unredacted free text** (`secretKeys` includes
  `description`), populated in part from `.env` comments
  (`index.html` bulk-import copy). Index the **name only** and use a static hint,
  so no free text propagates into a global list.
- **The page-view cache is not automatically fresh.** Create/update/delete
  handlers reload the current document in place (`dashboard.js:473-476`,
  `:560-563`, `:620-623`, `:925-927`) and `Refresh` (`:1386`) re-runs `load()`,
  while the workspace drawer uses `history.pushState` (`:1315`). The index needs
  invalidation, a generation guard, and a TTL backstop.
- **An undefined-only guard is not single-flight.** `paletteIndex` is assigned
  only when the fan-out settles, so every open before that starts another
  fan-out. A stored in-flight promise is required.
- **Server pagination is real and must be disclosed.**
  `GET /workspaces` is capped by `pageQuery` at `limit ≤ 100` with a default of
  100 (`apps/api/src/dashboard-router.ts:23,133-134`), and artifacts/knowledge
  return `truncated` plus a `cursor`. The palette searches the **first page**
  only; that must be stated in the UI and the docs rather than implied to be
  complete coverage.
- **There is no jsdom.** Matching logic must be extracted into pure functions.
- **`dashboard.js` calls a global `escape` it never imports** (call sites at
  lines 287, 289, 291, 297, 299, 756, 780, 1059, 1093; the identifier is never
  imported or defined, so it resolves to the deprecated `window.escape`). All
  palette HTML rendering therefore belongs in `dashboard-render.js`, which owns a
  correct local `escape`.
- **`/dashboard/models` is not a registered shell route.** `apps/api/src/dashboard-assets.ts`
  lists 14 shell paths without `/models`, and `apps/api/src/app.ts` has no
  catch-all, so the link 404s. The palette promotes Models to a first-class
  target, so this is repaired here.
- The `role="search"` landmark is already taken by `#workspace-filter`.
- ESLint declares no `setTimeout` global for `apps/api/dashboard/**/*.js`
  (`eslint.config.js:30-44`); existing code uses `globalThis.setTimeout`
  (`dashboard.js:366`). The debounced announcement must do the same.

## Requirements

- Functional: `CMD+K` (macOS) and `CTRL+K` (Windows/Linux) open the palette;
  pressing the combination again closes it.
- Functional: a visible `.icon-btn` in the top bar opens the palette, carrying
  `aria-keyshortcuts="Meta+K Control+K"`.
- Functional: page commands render synchronously on open, before any response
  settles.
- Functional: remote results fill in from **at most three concurrent** requests,
  never more.
- Functional: exactly one fan-out is in flight at a time; reopening while a
  load is pending reuses it.
- Functional: a `429` or network failure leaves that source **retryable** and is
  never cached as an empty list.
- Functional: the index is invalidated after any confirmed mutation or explicit
  refresh, and by a 60-second TTL backstop.
- Functional: typing filters instantly; Up/Down move the active option; Enter
  navigates; Escape closes and restores focus to the invoker.
- Functional: at most 50 results render, with a refinement hint when truncated
  and a standing note that results cover the first page of each resource.
- Non-functional: never index secret **values** or **descriptions**, or knowledge
  **content**.
- Non-functional: no `element.style` mutation, no client storage, no `console.`,
  no new dependency.
- Accessibility: combobox/listbox semantics with `aria-activedescendant`; focus
  never leaves the input.
- Security: every attacker-influenceable value is escaped through the local
  `escape` in `dashboard-render.js`.

## Architecture

```
hotkey / button ──> #command-palette dialog (showModal)
                       │
                       ├─ static page commands (synchronous, always present)
                       └─ ensurePaletteIndex()
                            ├─ single-flight promise latch (no duplicate fan-out)
                            ├─ generation counter (stale completions discarded)
                            ├─ batches of ≤3 concurrent requests
                            ├─ per-source: fulfilled -> entries; rejected -> keep retryable
                            └─ buildPaletteIndex(sources)  [pure]
                                 └─ rankPaletteMatches(index, query)  [pure]
                                       └─ renderPaletteResults(...)  [render module]
                                             └─ Enter ──> location.href = href

invalidation:  announce(mutation) │ Refresh │ history.pushState │ 60s TTL │ pagehide
```

### Index entry contract

```
{ id: string, group: string, label: string, hint: string, href: string, haystack: string }
```

`group` is one of `Pages`, `Workspaces`, `Projects`, `Secrets`, `API keys`,
`Models`, `Artifacts`. `href` is an absolute dashboard path.

### Source to entry mapping (frozen)

Only the listed fields are read; every other field in the response is discarded
before the entry is built.

| Ordered request | List path | Fields read | label | hint | href | Batch |
|---|---|---|---|---|---|---|
| `/workspaces?limit=100` | `data.workspaces` | `workspaceId`, `repositoryUrl` | `repositoryName(repositoryUrl)` | `workspaceId` | `/dashboard/workspaces/<id>` | 1 |
| `/projects` | `data.projects` | `id`, `name` | `name` | `id` | `/dashboard/projects/<id>` | 1 |
| `/secrets` | `data.secrets` | `name` | `name` | `Global secret` | `/dashboard/secrets` | 1 |
| `/api-keys` | `data.keys` | `id`, `name`, `state` | `name` | `state` | `/dashboard/api-keys` | 2 |
| `/provider-credentials` | `data.credentials` | `id`, `label`, `provider` | `label` | `provider` | `/dashboard/models` | 2 |
| `/agent-model-profiles` | `data.profiles` | `id`, `displayName` | `displayName` | `id` | `/dashboard/models` | 2 |
| `/artifacts?limit=100` | `data.artifacts` | `artifactId`, `logicalName` | `logicalName` | `artifactId` | `/dashboard/artifacts` | 3 |

**Excluded, with reasons:**

- `GET /knowledge` — the list response carries full item `content`; see Key
  Insights. A static `Knowledge` page command is offered instead.
- `GET /audit` — a palette is a navigator, not a log search; audit rows are
  high-volume and low-navigational-value.
- `GET /environments/:envId/secrets` — N+1 by construction; the static `Secrets`
  page command covers it.
- Secret `description` and any `provenance`/`contentHash` field — never read.

### Bounds and disclosure

- 200 entries per source, 1000 entries total, 50 rendered matches.
- One lowercase `haystack` per entry (`id + label + hint + group`).
- Ranking: exact prefix > word-start > substring. No fuzzy dependency.
- The dialog carries a standing note: results cover the first page of each
  resource type (100 records where the endpoint is paginated).
- 60-second TTL backstop (`Date.now() - paletteBuiltAt > 60_000`).

## Related Code Files

- Modify: `apps/api/dashboard/index.html`
- Modify: `apps/api/dashboard/dashboard.css`
- Modify: `apps/api/dashboard/dashboard.js`
- Modify: `apps/api/dashboard/dashboard-render.js`
- Modify: `apps/api/src/dashboard-assets.ts` (register the `/models` shell route)
- Modify: `apps/api/test/dashboard-ui-contract.test.ts`
- Modify: `apps/api/test/dashboard-ui-behavior.test.ts`
- Modify: `apps/api/test/dashboard-app-mount.test.ts`

## Implementation Steps

### Task 3.1 — Register the missing `/models` shell route

- **Goal:** `GET /dashboard/models` returns the shell instead of 404.
- **Target files and symbols:** `apps/api/src/dashboard-assets.ts:29-45` — the
  array passed to `router.get([...])`.
- **Steps:**
  1. Add `'/models'` to the route array, after `'/secrets'`.
  2. Change nothing else in that router.
- **Success criteria:** the served response for `/dashboard/models` is 200 HTML.
- **Verify:** `npx vitest run apps/api/test/dashboard-app-mount.test.ts` exits 0
  with the Task 3.6 case asserting `/models` returns 200.

### Task 3.2 — Pure palette functions

- **Goal:** the hotkey test, index build, ranking, and batching are pure,
  exported, and testable without a DOM.
- **Target files and symbols:** `apps/api/dashboard/dashboard.js` — add exported
  `PALETTE_BATCH_SIZE`, `PALETTE_SOURCE_REQUESTS`, `PALETTE_PAGE_COMMANDS`,
  `isPaletteHotkey(event)`, `chunkPaletteRequests(requests)`,
  `buildPaletteIndex(sources)`, `rankPaletteMatches(index, query)`.
- **Steps:**
  1. Add `PALETTE_BATCH_SIZE = 3`.
  2. Add `PALETTE_SOURCE_REQUESTS` — an ordered array of
     `{ key, path, group }` describing the seven requests in the mapping table,
     so the fetch order and batching are declared in one place and are testable.
  3. Add `PALETTE_PAGE_COMMANDS` — entries for Overview, Workspaces, Projects,
     Secrets, Models, API keys, GitHub, Knowledge, Artifacts, Audit, and Profile,
     each `{ id: 'page:<slug>', group: 'Pages', label, hint: 'Page', href }`.
  4. Add `isPaletteHotkey(event)` returning `true` only when the event exists,
     `(metaKey || ctrlKey)` is set, `altKey` is **not** set, and
     `String(event.key).toLowerCase() === 'k'`. It must not throw on a null,
     undefined, or malformed event.
  5. Add `chunkPaletteRequests(requests)` returning an array of arrays, each of at
     most `PALETTE_BATCH_SIZE` requests, preserving order. With seven requests it
     must return three batches of sizes 3, 3, 1.
  6. Add `buildPaletteIndex(sources)`:
     - starts from `PALETTE_PAGE_COMMANDS`;
     - maps each source array per the frozen mapping table, **reading only the
       listed fields**, skipping malformed rows and rows missing an id or label;
     - caps each source at 200 entries and the whole index at 1000;
     - attaches the lowercase `haystack`;
     - returns the array. It must tolerate `undefined` and missing source arrays.
  7. Add `rankPaletteMatches(index, query)`:
     - trims and lowercases the query; an empty query returns the first 50
       entries in index order (pages first);
     - ranks prefix match first, then word-start, then substring;
     - returns at most 50 entries.
  8. All seven symbols must be DOM-free — no `document`, no `window`.
- **Success criteria:** all seven are exported and DOM-free.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts` exits 0
  after Task 3.6's cases.

### Task 3.3 — Palette result rendering

- **Goal:** results render as escaped listbox options.
- **Target files and symbols:** `apps/api/dashboard/dashboard-render.js` — add
  exported `renderPaletteResults(entries, activeIndex)`.
- **Steps:**
  1. Return a string of `<li role="option">` elements — **direct children of the
     listbox**, no wrapper elements, or the options vanish from the
     accessibility tree.
  2. Each option: `id="palette-opt-<index>"`, `role="option"`,
     `aria-selected="true"` on the active index and the explicit string `"false"`
     on every other option, plus `data-href` and `data-palette-index`.
  3. Render the label, group, and hint through the file's local `escape`.
  4. When `entries` is empty, return a single non-option placeholder line.
- **Success criteria:** escaping is applied to every dynamic value; exactly one
  option carries `aria-selected="true"`.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts` exits 0
  with the Task 3.6 escaping and selection cases.

### Task 3.4 — Palette markup and CSS

- **Goal:** an accessible dialog exists in the shell and is styled with tokens.
- **Target files and symbols:** `apps/api/dashboard/index.html` — add the
  `#open-palette` button in `.topbar-right` and the `#command-palette` dialog
  before `</body>`; `apps/api/dashboard/dashboard.css` — add the `.palette-*`
  rules.
- **Steps:**
  1. In `.topbar-right`, immediately before `#theme-toggle`, add
     `<button id="open-palette" class="icon-btn" type="button" aria-label="Search (Command K)" aria-keyshortcuts="Meta+K Control+K" aria-haspopup="dialog">` with a magnifier SVG.
  2. Before `</body>`, add:

     ```html
     <dialog id="command-palette" aria-label="Search Cloud Harness">
       <label class="sr-only" for="palette-input">Search workspaces, projects, secrets, API keys, and pages</label>
       <input id="palette-input" type="text" role="combobox" aria-expanded="false" aria-controls="palette-results" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search workspaces, projects, secrets, API keys, pages…">
       <p id="palette-status" class="sr-only" aria-live="polite"></p>
       <ul id="palette-results" role="listbox" aria-label="Results"></ul>
       <p class="palette-note">Results cover the first page of each resource type.</p>
     </dialog>
     ```

  3. Do **not** add a `<form>`, a `role="search"` landmark, or
     `aria-activedescendant` in the static markup — the attribute is added and
     removed by script.
  4. CSS: `#command-palette` sized for a palette
     (`max-width: min(38rem, calc(100vw - 2 * var(--space-4)))`, top-aligned);
     the input must not inherit the global `button[type="submit"]` accent rule;
     `.palette-option` rows use `--surface-raised` and `--accent-soft` for the
     selected row; `.palette-note` uses `--ink-muted` at `--text-11`;
     `--shadow-overlay` on the dialog. OKLCH and tokens only; no hex, no
     `gradient()`, no inline styles.
  5. Add a `.palette-hint` rule for the `kbd`-style shortcut hint in the top-bar
     button and hide it at the narrow breakpoint, as `.profile-chip` is hidden at
     `dashboard.css:470`.
- **Success criteria:** the dialog, combobox input, listbox, and note exist with
  the stated roles; CSS contains no hex and no `gradient(`.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0.

### Task 3.5 — Wire the palette

- **Goal:** the hotkey, the button, the batched fan-out, the keyboard model, and
  navigation all work without ever exceeding the concurrency budget.
- **Target files and symbols:** `apps/api/dashboard/dashboard.js` — inside
  `initializeDashboard()`, add the palette controller and the global keydown;
  the final wiring block at lines 1385-1420.
- **Steps:**
  1. Hoist the dialog refs and this state near the other boot state:
     `let paletteIndex; let paletteBuiltAt = 0; let paletteLoadPromise; let paletteLoadGeneration = 0; let paletteStale = true; let palettePending; let paletteActive = -1; let paletteInvoker;`
     where `palettePending` is a `Set` of source keys that failed and still need
     fetching.
  2. Add `function invalidatePalette() { paletteStale = true; paletteLoadGeneration += 1; }`.
     It **only marks stale** — it never fetches, so over-invalidation costs at
     most one extra batch set on the next open, never an eager request.
  3. Add `function ensurePaletteIndex()`:
     - if `paletteLoadPromise` exists, return it (single flight);
     - if `!paletteStale && paletteIndex` return `Promise.resolve(paletteIndex)`;
     - capture `const generation = ++paletteLoadGeneration;`
     - build the request list from `PALETTE_SOURCE_REQUESTS`, **fetching only the
       keys in `palettePending`** when a previous partial load left some
       unfetched, otherwise all of them;
     - iterate `chunkPaletteRequests(...)` **sequentially**, awaiting
       `Promise.allSettled` within each batch, so at most
       `PALETTE_BATCH_SIZE` (3) requests are ever concurrent;
     - on each `fulfilled` result, record `{ key, entries }`; on each `rejected`,
       add the key to the next `palettePending` set and leave it absent from the
       index **without treating it as empty**;
     - if `generation !== paletteLoadGeneration`, discard the result entirely and
       do not assign;
     - otherwise assign the rebuilt `paletteIndex`, set `paletteBuiltAt = Date.now()`,
       `paletteStale = palettePending.size > 0`, and clear `paletteLoadPromise`
       in a `finally`.
  4. Add `function palettesStaleByTtl() { return Date.now() - paletteBuiltAt > 60_000; }`
     and treat the index as stale when it returns true.
  5. Add `function renderPalette(query)`: compute
     `rankPaletteMatches(paletteIndex ?? PALETTE_PAGE_COMMANDS, query)`, write
     `renderPaletteResults(entries, paletteActive)` into `#palette-results`, set
     `aria-expanded` to `"true"` when entries exist and `"false"` when empty, set
     `aria-activedescendant` to the active option id when one exists and
     **remove the attribute entirely** when none does, and scroll the active
     option with `scrollIntoView({ block: 'nearest' })`.
  6. Add `function openPalette(invoker)`: return early if any **other**
     `dialog[open]` exists; record `paletteInvoker`; `showModal()`; render page
     commands immediately; focus the input; announce the page-command count; then
     `void ensurePaletteIndex().then(() => { if (dialog.open) renderPalette(input.value); })`.
  7. Add `function closePalette()`: close the dialog and restore focus to
     `paletteInvoker`.
  8. Input handling: `input` re-renders synchronously and debounces only the
     live-region announcement (~150 ms, `"N results."`) using
     `globalThis.setTimeout` (ESLint declares no bare `setTimeout` for this
     directory). `keydown` on the input: `ArrowDown`/`ArrowUp` move
     `paletteActive` within bounds; `Home`/`End` jump; `Enter` navigates to the
     active entry's `href` via `location.href`; `Escape` is left to the dialog
     `cancel` event.
  9. Option handling: `mousedown` on `#palette-results` calls `preventDefault()`
     so the input keeps focus; `click` navigates using `data-href`.
  10. Dialog `cancel` event: `preventDefault()`, then `closePalette()` — the
      `createAsyncDialogController` pattern (`dashboard.js:80`).
  11. `#open-palette` click: `openPalette(event.currentTarget)`.
  12. Global keydown, bound once at the end of `initializeDashboard()`:
      `document.addEventListener('keydown', (event) => { if (!isPaletteHotkey(event)) return; if (dialog.open) { closePalette(); return; } event.preventDefault(); openPalette(document.querySelector('#open-palette')); });`
  13. Add `invalidatePalette()` at the top of the `announce` helper, so every
      confirmed mutation and the explicit `Refresh` mark the index stale. The
      workspace drawer's `history.pushState` call (`dashboard.js:1315`) also
      calls `invalidatePalette()`.
  14. In the existing `pagehide` handler, add
      `paletteIndex = undefined; paletteLoadGeneration += 1;`.
  15. Use `hidden`, `classList`, and attributes only — never `element.style`.
      Do not use `console.`, `localStorage`, `sessionStorage`, or
      `document.cookie`.
- **Success criteria:** at most three requests are concurrent; a reopen during a
  pending load issues no additional requests; a `429` leaves the source
  retryable; no CSP-violating API is used.
- **Verify:** the Task 3.6 suites exit 0, **and** the Phase 5 browser smoke Task
  5.1 proves the palette under a real limiter and an induced `429`.

### Task 3.6 — Tests first: palette contract, pure logic, and route

- **Goal:** the palette's observable surface is covered at the layers this
  harness can reach.
- **Target files and symbols:**
  `apps/api/test/dashboard-ui-contract.test.ts`,
  `apps/api/test/dashboard-ui-behavior.test.ts`,
  `apps/api/test/dashboard-app-mount.test.ts`.
- **Steps (red phase first):**
  1. Contract: assert `id="command-palette"`, `role="combobox"`,
     `aria-controls="palette-results"`, `role="listbox"`,
     `id="palette-status"` with `aria-live="polite"`, the `.palette-note`
     disclosure, and `id="open-palette"` with
     `aria-keyshortcuts="Meta+K Control+K"`. Assert the dialog markup contains no
     `<form` and no `role="search"`. Confirm the suite's existing forbidden
     substrings still hold for the new code.
  2. Behavior (pure): `isPaletteHotkey` true for `{metaKey:true,key:'k'}` and
     `{ctrlKey:true,key:'K'}`, false for `{key:'k'}` alone, false when `altKey`
     is set, and false without throwing for `{}` and `undefined`.
  3. Behavior (pure): `chunkPaletteRequests` over seven requests returns three
     batches sized 3, 3, 1, and never exceeds `PALETTE_BATCH_SIZE`.
  4. Behavior (pure): `buildPaletteIndex` always includes the page commands;
     maps each source row to the frozen href; **reads no undefined field** —
     passing a secret row with a `description` and a knowledge row with a
     `content` must not place either string anywhere in the produced entry;
     tolerates a missing source array; caps a 250-row source at 200 entries.
  5. Behavior (pure): `rankPaletteMatches` with an empty query returns the first
     50 entries; a prefix match outranks a substring match; the result length
     never exceeds 50.
  6. Behavior (render): `renderPaletteResults` escapes a label containing
     `<img src=x onerror=alert(1)>` so the raw tag does not appear in the output,
     and marks exactly one option `aria-selected="true"`.
  7. Mount: assert `GET /dashboard/models` returns 200.
  8. Run the behavior and mount suites before Tasks 3.1-3.4 land and confirm the
     expected failures. This red state is expected.
- **Success criteria:** the suite fails before the implementation and passes
  after; no assertion is tautological.
- **Verify:**
  - Red: `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts` exits
    non-zero (missing export `isPaletteHotkey`).
  - Green: `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-app-mount.test.ts` exits 0.

## Tests Before (TDD)

- Contract: palette landmark, combobox/listbox roles, live region, disclosure
  note, trigger button, and the absence of a second search landmark or a form.
- Behavior: hotkey predicate, batch chunking, index mapping and field
  minimization, caps, ranking and bounds, escaping, single-selection rendering.
- Mount: the `/models` shell route returns 200.
- Regression gate: `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-app-mount.test.ts`

## Tests After (TDD)

No additional tests. Concurrency scheduling, single-flight behavior, focus
management, `scrollIntoView`, `showModal` inertness, and arrow-key traversal are
DOM-, timer-, and layout-coupled and cannot be exercised by the hand-rolled fake
harness; they are verified in the Phase 5 browser smoke against a harness that
mounts the real limiter. Adding fake-DOM tests for them would assert the fake,
not the browser.

## Refactor

- Removes the need for any caller to reach `window.escape` for palette output by
  placing all palette rendering in the render module.
- Registers the previously missing `/models` shell route rather than leaving a
  dead navigation target.
- Declares the request set and batching in exported data so scheduling is
  testable rather than implicit in a callback body.

## Todo

- [ ] Task 3.6 (red): failing contract, behavior, and mount assertions
- [ ] Task 3.1: register the `/models` shell route
- [ ] Task 3.2: pure hotkey, batch, index, and ranking functions
- [ ] Task 3.3: `renderPaletteResults`
- [ ] Task 3.4: palette markup and CSS
- [ ] Task 3.5: wire single-flight batched fan-out, keyboard model, navigation, invalidation
- [ ] Verify green: contract + behavior + mount suites

## Success Criteria

- `CMD+K` and `CTRL+K` open the palette; the same combination closes it.
- Page commands appear synchronously on open, before any response settles.
- At most three requests are concurrent at any time; no duplicate fan-out.
- A `429` leaves the affected source retryable; it is never cached as empty.
- The index is marked stale by any confirmed mutation, by `Refresh`, by the
  workspace drawer's `pushState`, and by the 60-second TTL.
- Typing filters instantly; Enter navigates; Escape closes and restores focus.
- At most 50 results render; the first-page-only bound is disclosed in the UI.
- No secret value, secret description, or knowledge content is ever indexed or
  rendered.
- `GET /dashboard/models` returns 200.
- No `element.style`, client storage, or `console.` appears in the new code.

## Risk Assessment

- **Risk (highest, was a plan defect):** the fan-out exceeds the eight-concurrent
  per-principal budget and the throttled sources are cached as empty.
  **Mitigation:** batches of three, single-flight latch, failures stay pending and
  are refetched on the next open, generation guard, and a Phase 5 smoke that runs
  against the real limiter.
- **Risk:** CSP violations are invisible to the entire test suite — neither the
  static-file contract test nor the fake-DOM behavior test evaluates CSP, so a
  palette using `element.style` would pass every automated gate and be broken in
  production. **Mitigation:** forbid `element.style`; require the Phase 5 browser
  smoke to assert the real CSP header and a clean console.
- **Risk:** knowledge content or secret descriptions leak into a global index.
  **Mitigation:** knowledge is excluded entirely; secrets are indexed by name
  only; Task 3.6 asserts that a `description` and a `content` string never appear
  in a produced entry.
- **Risk:** focus moves into the listbox. **Mitigation:** arrow keys move only
  `aria-activedescendant`; options `preventDefault()` on `mousedown`.
- **Risk:** `aria-selected` omitted, or `aria-activedescendant` set to `""`.
  **Mitigation:** explicit assertions; the attribute is removed, not blanked.
- **Risk:** silently incomplete coverage beyond page one. **Mitigation:** explicit
  `limit=100`, a standing disclosure note in the dialog, and documentation.
- **Risk:** unbounded memory or DOM. **Mitigation:** 200 per source, 1000 total,
  50 rendered.

## Security Considerations

- No new authentication or authorization surface: the palette consumes endpoints
  that already scope results to the signed-in principal, so the search path
  cannot drift from the list path's scoping.
- Only an allowlisted projection is read per source (mapping table). Secret
  values, secret descriptions, knowledge content, provenance, and content hashes
  are never read into the index.
- Every attacker-influenceable field (workspace repository URL, secret name,
  credential label, profile display name, artifact logical name) is rendered
  through the render module's local `escape`.
- The fan-out cannot be used to amplify load: three concurrent requests maximum,
  one fan-out in flight, failures retried only on a later user-initiated open,
  bounded by the endpoint's own 120/min limiter.
- No client storage, no telemetry, no external request — consistent with the CSP
  `default-src 'none'`.
- The palette exposes only the principal's own resources, matching the visibility
  the equivalent pages already grant.

## Next Steps

Proceed to Phase 4 (documentation sync).

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
