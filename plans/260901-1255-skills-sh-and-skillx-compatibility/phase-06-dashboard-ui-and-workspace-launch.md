---
phase: 6
title: "Dashboard Skills Management UI & Workspace Launch Integration (TDD/E2E)"
status: pending
priority: P1
effort: "30h"
dependencies: [5]
---

# Phase 6: Dashboard Skills Management UI & Workspace Launch Integration (TDD/E2E)

## Overview
Deliver one unified **Skills** page in the vanilla SPA at `apps/api/dashboard/` that manages the whole skill lifecycle: Library (CRUD plus markdown editor), Import wizard with durable job progress, revision history with diff/restore/fork, usage and lock visibility with bulk operations, and a Registry tab that finally consumes `/api/v1/toolkits`. At the same time reduce the Open Workspace dialog to Skill Set selection with a live preflight conflict preview.

Current state that this phase replaces: `apps/api/dashboard/index.html` ships an `#toolkits-selection-grid` placeholder inside the Open Workspace dialog, but no code in `dashboard.js`, `dashboard-api.js`, or `dashboard-render.js` reads or populates it and no test covers it. That dead placeholder is removed rather than extended.

## Requirements

### Functional
- **Navigation and shell:**
  - Add a `Skills` link under the *Configuration* group in `apps/api/dashboard/index.html` (`href="/dashboard/skills"`, `data-section="skills"`).
  - Add `/skills` to every route registry, because there are three and all are exhaustive: the shell allowlist array in `apps/api/src/dashboard-assets.ts:42-62` (19 paths from `/` to `/profile`, which does include `/knowledge` and `/mcp-servers`), the path list iterated by `apps/api/test/dashboard-app-mount.test.ts:44`, and the client-side dispatch on `location.pathname` in `apps/api/dashboard/dashboard.js:661-676`. Also add the page entry to `PALETTE_PAGE_COMMANDS` in that same `dashboard.js` (the `/dashboard/...` entries start around line 309, including `page:knowledge`), and extend the hard-coded nav path/label list in `apps/api/test/dashboard-ui-contract.test.ts:100-115`, which pins all current dashboard hrefs and would otherwise fail as soon as the nav entry is added.
  - `#skills-section` hosts four tabs (Library, Discover, Skill Sets, Registry) as a `role="tablist"` with `aria-selected`, arrow-key navigation, and `aria-controls`/`aria-labelledby` wiring.
- **Library tab (`#skills-tab-library`)** — the management surface for installed, custom, and imported skills:
  - Toolbar: debounced search (`#skills-library-search`, 300 ms), provider filter, state filter (`enabled`/`disabled`/`archived`), tag filter, sort, and a "New custom skill" action.
  - Table (`#skills-library-table`): selection checkbox, name, provider badge, tier badge (`built-in`/`owner`/`workspace`), short revision digest, state pill, set-membership count, and updated time. Figures use tabular numerals, and the table collapses to stacked cards under `47.9375rem`.
  - Row menu: Enable/Disable, Edit (custom only), Fork as custom, Refresh from upstream, Add to Skill Set, View usage, Archive.
  - Bulk bar (`#skills-bulk-bar`) renders only when at least one row is selected: Enable, Disable, Add to set, Tag, Archive. Disable and Archive submit `POST /api/v1/skills/bulk` and render the per-item result, including each locked row's blockers; rows that succeeded leave the selection, locked rows stay selected.
  - Detail drawer (`#skill-detail`) with four sub-views: Instructions, Files, Revisions, Usage.
- **Instructions editor:**
  - Instructions render as markdown by default (`#skill-detail-instructions`); Files (`#skill-detail-files`) lists manifest paths, byte sizes, and `has_executable_assets`.
  - Custom skills expose an Edit toggle that reveals `#skill-editor` with `#skill-editor-save` and `#skill-editor-status`. Client validation requires a non-empty frontmatter `name`, rejects NUL characters and oversized bodies, and blocks submit before any request is sent.
  - Saving sends `PATCH /api/v1/skills/:skillId` with `expectedGeneration`; success announces the new revision id and refreshes the Revisions view. A 409 reuses the existing unsaved-changes recovery pattern from `file-conflict-dialog` (copy my changes, review latest, cancel) and never discards the draft.
- **Revisions view:**
  - `#skill-detail-revisions` lists revisions with digest short prefix, `origin`, source commit or parent revision, created time, and live snapshot count.
  - Per-revision actions: View content, Diff against current (`#skill-revision-diff`, a unified diff with added/removed line styling plus an accessible text alternative), Restore as new revision, Fork as custom.
  - Restore and fork both state in the UI that they create a new immutable revision instead of rewriting history.
- **Import wizard and job progress:**
  - `#skill-import-dialog` is a three-step wizard: source (`#skill-import-source`: skills.sh `owner/repo`, SkillX slug, or HTTPS Git URL; plus `#skill-import-ref` and `#skill-import-scope`), review (`#skill-import-review`: normalized skill names, digest preview, tier and scope, validation warnings), and progress (`#skill-import-job`).
  - Progress polls `GET /api/v1/skills/imports/:jobId` with backoff, shows per-skill progress, offers Cancel while queued or running, and on failure shows the bounded error code with a retry (`#skill-import-retry`) that reuses the reviewed source. `CACHE_MISS` and provider timeouts render explicit guidance instead of a generic failure message.
- **Usage and locks:**
  - `#skill-detail-usage` lists the Skill Sets and live workspace snapshots referencing the skill with their generations.
  - Archive, Disable, and Delete are disabled with an explanatory note when the usage view reports a lock, so the operator sees the cause before a 409 is returned.
- **Discover tab (`#skills-tab-discover`):**
  - Unified search with provider chips (`Installed`, `Suggestions`, `skills.sh`, `SkillX`, `Git URL`) and per-provider status, latency, or degraded warnings.
  - Every result carries a state badge (`Cached`, `Remote`, `Update available`) and an installed-versus-suggestion badge, because presets such as `mattpocock/skills` and `obra/superpowers` are recommendations that must be installed and must never render as already-available skills.
  - Actions: Install (opens the wizard at the review step) and Add to Skill Set.
- **Skill Sets tab (`#skills-tab-sets`):**
  - Two-pane builder (`#skill-set-builder`): a picker (`#skill-set-picker`) with search and filters on the left, ordered members on the right (`#skill-set-members`) with drag handles plus keyboard up/down buttons, the pinned revision per member with a change-pin control, and an inline duplicate-name warning.
  - Save (`#skill-set-save`) submits name, description, and the ordered member list with `expectedGeneration`; a 409 offers reload-and-merge. Delete is generation-fenced and reports `#skill-set-status` while pending.
- **Registry tab (`#skills-tab-registry`):**
  - `#skills-registry-table` lists every toolkit and registry source with kind, enabled state, pinned ref and commit OID, cache state (`cached`/`missing`/`quarantined`), skill count, disk size, and lock state.
  - Actions: Preview (`/api/v1/toolkits/preview`), Install skills into Library, Enable/Disable, Pin ref or revision, Refresh from upstream, and Remove from cache when unlocked.
  - Registry entries are suggestions, not built-ins. Only skills shipped inside the executor image render in the non-installable built-in group.
- **Open Workspace dialog integration:**
  - Remove the unused `#toolkits-selection-grid` placeholder and add a Skill Sets multi-select (`#open-skill-sets-select`) rendered as removable chips (`#open-skill-sets-chips`), plus `#skills-manage-link` routing to the Skills page.
  - `#open-workspace-preview` is fed by `POST /api/v1/skill-sets/preview` and shows unique skills, deduplicated skills, shadowed skills, disabled entries, cache readiness, and the resolved lock hash.
  - `#open-skill-conflicts` renders same-tier different-digest collisions as radio choices that populate `skillOverrides[name] = revisionId`; `#submit-open-workspace` stays disabled until every conflict is resolved, and a stale set generation shows a refresh prompt instead of a failed launch.
  - MCP and REST callers keep the direct `toolkits` array in `workspace_open`; only the dashboard switches to set-only selection.

### Non-functional / Accessibility
- Follow `docs/design-guidelines.md` and keep `apps/api/dashboard/dashboard.css` the styling owner: OKLCH tokens only, no hex, no `gradient(`, hairline borders, radius and motion tokens, 44px touch targets, 16px inputs, and a `prefers-reduced-motion` off-ramp for every transition.
- No inline `style=` attributes, no web fonts, and no browser storage. Only theme and display name persist through `PUT /api/v1/preferences`, whose schema accepts `{ theme?, displayName? }` under `.strict()` plus a `.refine` (`apps/api/src/dashboard-router.ts:19-22`; the route handler is at `:125`, and lines 96-107 are the `/api/v1/profile` handler). Filters and the active tab stay in memory for the session, so the phase must not claim they persist. The prohibition on client storage comes from the contract assertions in `apps/api/test/dashboard-ui-contract.test.ts` that forbid `localStorage`, `sessionStorage`, and `document.cookie` in dashboard scripts, not from a CSP storage directive.
- Tabs, drawer, wizard, and conflict radios are fully keyboard navigable, trap focus while a modal is open, restore focus to the invoking control on close, and announce progress through `aria-live="polite"`.
- Render only allowlisted fields: never print runner tokens, owner ids, container names, workspace paths, or CAS root paths. Escape every attacker-influenceable value through the existing `escape` helper in `dashboard-render.js`.

## Architecture
```text
apps/api/dashboard/
  ├── index.html            -> Nav item, #skills-section with four tabs, detail drawer,
  │                            import wizard, revision diff view, reduced Open Workspace dialog
  ├── dashboard.css         -> Skill table, badges and state pills, drawer sub-views, wizard steps,
  │                            two-pane set builder, diff lines, registry table, conflict radios
  ├── dashboard-api.js      -> api('/skills'), api('/skills/:id/revisions'), api('/skills/bulk'),
  │                            api('/skills/imports/:jobId'), api('/skill-sets/preview'), api('/toolkits')
  ├── dashboard-render.js   -> Pure renderers: library rows, detail sub-views, revision list and diff,
  │                            import job progress, set builder, registry rows, launch preview
  └── dashboard.js          -> State, event wiring, 300ms search debounce, import polling with backoff,
                               generation-conflict recovery, bulk per-item result handling
```

State held in `dashboard.js`:
```text
skillsState = {
  tab, query, filters: { provider, state, tag }, cursor,
  selected: Set<skillId>,
  detail: { skillId, view, revisionId, diff, draft, dirty },
  importJob: { jobId, step, polling, error },
  setDraft: { setId, name, description, members[], generation, dirty },
  launch: { setIds[], overrides{}, preview, conflicts }
}
```

## UI contract (selectors the tests assert)
| Selector | Purpose |
|---|---|
| `data-section="skills"`, `/dashboard/skills` | Sidebar entry and shell route |
| `#skills-section`, `#skills-tab-{library,discover,sets,registry}` | Section and tab controls |
| `#skills-library-search`, `#skills-library-table`, `#skills-bulk-bar` | Library toolbar, table, bulk actions |
| `#skill-detail`, `#skill-detail-instructions`, `#skill-detail-files`, `#skill-detail-revisions`, `#skill-detail-usage` | Detail drawer and its four views |
| `#skill-editor`, `#skill-editor-save`, `#skill-editor-status` | Custom-instruction editor |
| `#skill-revision-diff` | Unified diff view |
| `#skill-import-dialog`, `#skill-import-source`, `#skill-import-ref`, `#skill-import-scope`, `#skill-import-review`, `#skill-import-job`, `#skill-import-retry` | Import wizard |
| `#skill-set-builder`, `#skill-set-picker`, `#skill-set-members`, `#skill-set-save`, `#skill-set-status` | Skill Set builder |
| `#skills-registry-table`, `#skills-registry-status` | Toolkit and registry inventory, including the `#skills-registry-status` live region the implementation step must create |
| `#open-skill-sets-select`, `#open-skill-sets-chips`, `#open-skill-conflicts`, `#open-workspace-preview` | Launch integration |
| `#skills-manage-link` | Shortcut from the launch dialog to the Skills page |

## Milestones & Exit Criteria

This phase carries a wide surface behind one gate. Four ordered milestones keep a scheduling signal; each one ends in a runnable, tested increment.

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M1 — Shell, Library & Registry (12h)** | `/skills` route and shell allowlist, four tabs, library table with filters and selection, custom-skill create/archive, detail drawer skeleton, Registry tab read plus enable/disable/pin, and extraction of the `FakeElement` test DOM (declared at `apps/api/test/dashboard-ui-behavior.test.ts:11`) into `apps/api/test/dashboard-test-dom.ts` so the new interaction patterns can reuse it; no shared DOM helper exists anywhere today, so this is a genuine extraction and not a move | `/skills` returns 200 from the shell router; nav, tab, library, and registry contract and behavior assertions pass |
| **M2 — Editor & revision history (9h)** | Instructions editor with validation and 409 recovery, Files view with `has_executable_assets`, revisions list, revision content, unified diff, restore, fork, usage view | Editor and revision tests pass; restore and fork are verified to create new revisions rather than mutating history |
| **M3 — Import wizard & job progress (5h)** | Three-step wizard, review step, polling with backoff, cancel, retry, `CACHE_MISS` and degraded-provider guidance | Wizard tests pass and job state renders purely from `GET /api/v1/skills/imports/:jobId` |
| **M4 — Bulk results & launch integration (4h)** | Per-item bulk result rendering with locked rows retained, usage-driven disable/archive guards, Skill Sets multi-select with chips, preflight preview, conflict radios, `#skills-manage-link`, removal of `#toolkits-selection-grid` | Launch tests pass; the contract test asserts the placeholder is gone and launch stays disabled while a conflict is unresolved |

If M1 or M2 overruns, stop and report before starting M3: the honest split point is M1-M2 (management surface) versus M3-M4 (import and launch), and re-planning from a tested increment is cheaper than absorbing the overrun inside one gate.

## Related Code Files
- Modify: `apps/api/dashboard/index.html`
- Modify: `apps/api/dashboard/dashboard.css`
- Modify: `apps/api/dashboard/dashboard-api.js`
- Modify: `apps/api/dashboard/dashboard-render.js`
- Modify: `apps/api/dashboard/dashboard.js`
- Modify: `apps/api/dashboard/dashboard.js` (`PALETTE_PAGE_COMMANDS` page list plus the `location.pathname` dispatch at `:661-676`)
- Modify: `apps/api/src/dashboard-assets.ts` (the shell allowlist array at `:42-62`)
- Modify: `apps/api/test/dashboard-ui-contract.test.ts` (the hard-coded nav list at `:100-115`)
- Modify: `apps/api/test/dashboard-ui-contract.test.ts`
- Modify: `apps/api/test/dashboard-app-mount.test.ts`
- Modify: `apps/api/test/dashboard-ui-behavior.test.ts`
- Modify: `apps/api/test/dashboard-ui-behavior.test.ts`
- Create: `apps/api/test/dashboard-test-dom.ts`
- Create: `apps/api/test/dashboard-skills-ui.test.ts`

## Implementation Steps
1. **Tests-First (TDD):**
   - Extend `apps/api/test/dashboard-ui-contract.test.ts`:
     - Assert the `/dashboard/skills` nav entry and every selector in the UI contract table above.
     - Assert the Open Workspace dialog contains `#open-skill-sets-select` and `#open-workspace-preview` and no longer contains `#toolkits-selection-grid`.
     - Keep the existing assertions passing: a single `<h1>`, no inline `style=`, no hex colour or `gradient(` in CSS, and no `localStorage`, `sessionStorage`, or `document.cookie` in the scripts.
   - Extend `apps/api/test/dashboard-app-mount.test.ts` with the `/skills` shell route so the new page is served, not only linked.
   - Write `apps/api/test/dashboard-skills-ui.test.ts` importing `FakeElement` from the shared helper extracted in step 2 (`apps/api/test/dashboard-test-dom.ts`) and pure helpers exported from `dashboard.js` and `dashboard-render.js`. Extraction is part of this phase because `FakeElement` is currently a local class inside `apps/api/test/dashboard-ui-behavior.test.ts:8` and cannot be reused as-is:
     - Tab switching updates `aria-selected` and requests the list once per tab entry.
     - Typing in the search field debounces to a single request inside the window.
     - Row selection drives bulk-bar visibility and produces the `POST /api/v1/skills/bulk` body; a per-item conflict keeps the failed rows selected and reports their blockers.
     - The editor refuses submit on invalid frontmatter or NUL characters, and a 409 keeps the draft and reports the conflict.
     - Import polling stops on a terminal state, exposes Cancel while running, and renders `CACHE_MISS` guidance.
     - Revision diff rendering marks added and removed lines and exposes a text alternative.
     - The launch preview disables `#submit-open-workspace` while conflicts remain and enables it once every conflict has an override.
2. **Implement Front-End Assets:**
   - Update `index.html`: nav item, the four-tab section, detail drawer, import wizard dialog, diff view, and the reduced Open Workspace dialog. The Registry tab must include the `#skills-registry-status` live region named in the UI contract table.
   - Update `dashboard.css`: skill table, badges and state pills, drawer sub-views, wizard steps, diff lines, two-pane builder, registry table, conflict radios, and their narrow-screen and reduced-motion rules.
   - Update `dashboard-api.js`: skills, revisions, diff, restore, fork, usage, bulk, import job, search, skill-set, preview, and toolkit registry methods, each mutation carrying `expectedGeneration`.
   - Update `dashboard-render.js`: pure renderers per surface, with every value escaped through the existing `escape` helper.
   - Update `dashboard.js`: `skillsState`, tab and drawer controllers, 300 ms debounce, import polling with backoff, bulk per-item result handling, and 409 recovery that reloads server state instead of trusting local state.
3. **Verification:**
   - Run `npm test apps/api/test/dashboard-ui-contract.test.ts`, `npm test apps/api/test/dashboard-skills-ui.test.ts`, `npm test apps/api/test/dashboard-ui-behavior.test.ts`, and `npm test apps/api/test/dashboard-app-mount.test.ts`.
   - Run `npx vitest run apps/api/test/dashboard-*.test.ts`, then `npm run verify`.
   - Re-check both themes and 375px width in a browser before declaring the phase done, as `docs/design-guidelines.md` requires.

## Success Criteria
- [ ] A single Skills page under Configuration covers the full lifecycle: browse and filter the library, edit custom instructions, import with visible job progress, inspect and restore revisions, and see usage and locks before archiving.
- [ ] Bulk archive or disable returns per-item results: locked rows stay selected with their blockers while successful rows apply.
- [ ] The Registry tab shows cache state, pinned commit, skill count, and lock state for every toolkit, and clearly separates suggestions from installed skills.
- [ ] Users select multiple Skill Sets when launching, resolve conflicts through radio choices, and cannot launch while a conflict is unresolved.
- [ ] The dead `#toolkits-selection-grid` placeholder is gone and no dashboard code path references it.
- [ ] The UI is responsive, keyboard navigable, screen-reader announced, and passes every contract, behavior, mapper, and mount assertion.

## Risk Assessment
- **Risk:** Front-end state drifting from concurrent database changes.
- **Mitigation:** Treat server responses as authoritative: reload the affected view after any 409 and never enable a mutation from a stale generation.
- **Risk:** A management surface this wide growing into an unmaintainable single file.
- **Mitigation:** Keep renderers pure and exported from `dashboard-render.js`, keep all fetching in `dashboard-api.js`, and hold per-feature state in `skillsState`, so `dashboard.js` only wires events.
- **Risk:** Executable content becoming reachable through a UI affordance the operator did not intend.
- **Mitigation:** The editor stores content and never executes it; the Files view shows `has_executable_assets`; `skills_run` stays behind the phase 4 digest-verified snapshot path so the dashboard cannot bypass it.
- **Risk:** A four-tab management surface overrunning a single 20h gate, which delays the launch integration that delivers the original user value.
- **Mitigation:** Ship the four milestones in order and treat M1-M2 as the split point; M3 and M4 are the first candidates to move into their own phase if M1 or M2 overruns.
