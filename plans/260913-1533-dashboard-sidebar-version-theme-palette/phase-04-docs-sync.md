---
phase: 4
title: "Documentation sync"
status: pending
priority: P2
effort: "1h"
dependencies: [3]
---

# Phase 4: Documentation sync

## Goal

Internal design guidance and the official user docs describe the UI that
actually ships: a version readout in the left rail, a single cycling theme icon,
and a `CMD+K` search palette.

## Context Links

- `docs/design-guidelines.md` — owns the dashboard WHY; its "Top bar" and
  "Components" sections enumerate the current controls
- `docs-site/dashboard/index.md` — the official operator dashboard tour
- `AGENTS.md` — "evaluate and update both internal docs (`docs/`) and the official
  docs site (`docs-site/`)"
- `apps/api/test/dashboard-ui-contract.test.ts` — the executable authority for
  the DOM contract that both documents describe

## Key Insights

- Documentation owns **WHY and WHERE**; code, schemas, and tests own **WHAT and
  HOW**. Both edits must point at the executable owners rather than restating
  rule tables, defaults, or CSS values.
- `docs/design-guidelines.md` currently says the top bar carries "the theme
  control" and that the dashboard has a "**system / light / dark** control in the
  top bar". Both statements need to become the single icon control.
- `docs-site/dashboard/index.md` currently advertises "server-persisted theme
  preferences (System, Light, Dark)". It must describe the icon control and gains
  two new capability bullets (version readout, search palette).
- This change adds **no** MCP tool, no config key, and no CLI surface, so
  `.agents/skills/cloudharness/` and `plugins/cloud-harness/` need no edit and
  `npm run plugin:sync` must not be run as a consequence of this phase.
- The CLI `--version` fix changes an existing CLI output value, but not its
  contract, flag, or documented usage; `docs/` does not document the version
  string.

## Requirements

- Functional: `docs/design-guidelines.md` describes the cycling theme icon, the
  sidebar version readout, and the command palette, each pointing at its
  executable owner.
- Functional: `docs-site/dashboard/index.md` lists the search palette and the
  version readout, and no longer enumerates three theme buttons.
- Functional: `docs-site/dashboard/index.md` states the search bounds honestly:
  results cover the first page of each resource type, and knowledge items are
  reached through the Knowledge page's own search rather than the palette.
- Non-functional: no behavior tables, defaults, or CSS values are copied into
  docs.
- Non-functional: no secrets, tokens, private URLs, or local absolute paths.
- Non-functional: the docs-site build must still succeed.

**Accuracy constraint (corrects an earlier draft):** the palette does **not**
read "only metadata" in general — `GET /knowledge` returns full item content, so
knowledge is excluded from the palette rather than described as metadata-only.
The palette reads an allowlisted projection from seven endpoints and indexes
secret **names** without secret descriptions. The documentation must say that,
not the stronger and false "reads only metadata" claim.

## Architecture

Two edits, each pointing at owners:

| Document | Section | New content | Executable owner referenced |
|---|---|---|---|
| `docs/design-guidelines.md` | Adaptive dark theme | one cycling icon control, three states, server-persisted | `dashboard.js` cycler, `dashboard-router.ts` preferences route, `dashboard-assets.ts` first-paint injection |
| `docs/design-guidelines.md` | Components → Top bar | replace "the theme control" with the search trigger and the theme icon | `index.html` top bar |
| `docs/design-guidelines.md` | Components | add a "Command palette" entry | `dashboard-render.js` `renderPaletteResults`, `dashboard.js` index build |
| `docs/design-guidelines.md` | Components → Navigation | note the sidebar version readout | `version.ts`, `dashboard-assets.ts` |
| `docs-site/dashboard/index.md` | Key Sections | search palette bullet | — |
| `docs-site/dashboard/index.md` | Key Sections → Profile & Preferences | icon control instead of three named states | — |
| `docs-site/dashboard/index.md` | Design System & Security Invariants | note that palette search reads an allowlisted projection of seven resource endpoints and never indexes secret values, secret descriptions, or knowledge content | — |

## Related Code Files

- Modify: `docs/design-guidelines.md`
- Modify: `docs-site/dashboard/index.md`

## Implementation Steps

### Task 4.1 — Update the internal design guidelines

- **Goal:** `docs/design-guidelines.md` matches the shipped controls.
- **Target files and symbols:** `docs/design-guidelines.md` — the "Adaptive dark
  theme" subsection under "Color", and the "Components" section ("Top bar",
  "Navigation").
- **Steps:**
  1. In "Adaptive dark theme", replace the sentence describing a
     "**system / light / dark** control in the top bar" with the single cycling
     icon control: one button in the top bar cycles system → light → dark, the
     label states the next action, and the control is never `aria-pressed`
     because it has three states.
  2. Keep the existing, still-true paragraph about server-side persistence
     (`PUT /api/v1/preferences`, HttpOnly cookie, first-paint injection). Do not
     restate the mechanism in more detail than it already has.
  3. In "Components → Top bar", replace "the theme control" with the search
     trigger and the theme icon.
  4. Add a "Command palette" bullet under "Components": opened by the top-bar
     search button or `CMD+K` / `CTRL+K`, indexes page commands plus an
     allowlisted projection from seven resource endpoints, is bounded to 200
     entries per source and 50 rendered matches, covers only the first page of
     each paginated resource, is a keyboard-driven combobox/listbox, and never
     indexes secret values, secret descriptions, or knowledge content.
  5. In "Components → Navigation", add that the rail carries a server-version
     readout that hides when collapsed to icons.
  6. Do not add CSS values, token lists, or rule tables — point at
     `dashboard.css` and the contract test as the owners, as the document already
     does.
- **Success criteria:** the document no longer describes three theme buttons, and
  describes the palette and the version readout.
- **Verify:** `node -e "const t=require('fs').readFileSync('docs/design-guidelines.md','utf8'); if(/system \\/ light \\/ dark control/.test(t)) throw new Error('stale theme description'); if(!/Command palette/.test(t)) throw new Error('palette not documented'); if(!/sidebar-version|version readout/i.test(t)) throw new Error('version readout not documented');"`
  exits 0.

### Task 4.2 — Update the official dashboard docs

- **Goal:** the operator tour reflects the shipped dashboard.
- **Target files and symbols:** `docs-site/dashboard/index.md` — "Key Sections"
  and "Design System & Security Invariants".
- **Steps:**
  1. In "Key Sections", add a bullet for the search palette: press `CMD+K` or
     `CTRL+K` (or use the top-bar search button) to jump to any page or find a
     workspace, project, secret, API key, model credential or profile, or
     artifact. State the bound: results cover the first page of each resource
     type. Note that memories and journals are searched from the Knowledge page,
     which has its own search.
  2. In the "Profile & Preferences" bullet, replace "configure server-persisted
     theme preferences (System, Light, Dark)" with the icon control that cycles
     system, light, and dark and persists server-side.
  3. In "Design System & Security Invariants", add that dashboard search reads an
     allowlisted projection from seven resource endpoints and never indexes
     secret values, secret descriptions, or knowledge content.
  4. Keep the existing "No Client Storage" invariant text accurate — the palette
     caches in memory for the page view only, which does not violate it.
  5. Match the file's existing link style for section links.
  6. Do **not** describe the palette as searching "all" resources or as reading
     "only metadata"; both would be false.
- **Success criteria:** no enumeration of three theme buttons remains; the
  palette is documented.
- **Verify:** `node -e "const t=require('fs').readFileSync('docs-site/dashboard/index.md','utf8'); if(/\(System, Light, Dark\)/.test(t)) throw new Error('stale theme enumeration'); if(!/CMD\+K/.test(t)) throw new Error('palette not documented');"`
  exits 0.

### Task 4.3 — File the release-pipeline follow-up issue

- **Goal:** the version-lag risk is tracked, not silently fixed or dropped.
- **Target files and symbols:** GitHub issue in `bestagentkits/cloud-harness-mcp`.
- **Steps:**
  1. Search for an existing open issue describing the deploy/release ordering
     problem before filing. If one exists, add a comment with the evidence
     gathered in Phase 1 rather than opening a duplicate.
  2. Otherwise open one issue titled
     `fix(release): production deploys the pre-version-bump commit, so the running version lags the release tag`.
  3. Body must state the verified mechanism: `deploy.yml` deploys
     `workflow_run.head_sha` (the merge commit) on CI success for `main`;
     `release.yml` then pushes `chore(release): X [skip ci]`, and `[skip ci]`
     means CI never runs on that commit, so `deploy.yml` never fires for it.
     Consequence: production always runs the previous version's manifest.
  4. Propose options without prescribing: deploy the release commit, or derive
     the displayed version from the release tag.
  5. Do not include secrets, tokens, host names beyond what is already public in
     `docs/deployment.md`, or private environment values.
- **Success criteria:** an issue URL exists, or a comment on an existing issue is
  recorded.
- **Verify:** `gh issue view <number> --json number,title,state` exits 0 and
  reports the expected title.

## Tests Before (TDD)

Not applicable — this phase changes prose only. The regression gate is the
docs-site build plus the two content assertions in Task 4.1 and Task 4.2.

## Tests After (TDD)

Not applicable. Content assertions above are the mechanical pass condition.

## Refactor

None. No code changes in this phase.

## Todo

- [ ] Task 4.1: update `docs/design-guidelines.md`
- [ ] Task 4.2: update `docs-site/dashboard/index.md`
- [ ] Task 4.3: file or comment the release-pipeline follow-up issue
- [ ] Verify: docs-site build succeeds

## Success Criteria

- Neither document describes three theme buttons.
- Both the palette and the sidebar version readout are documented.
- The docs-site build passes.
- The release-pipeline risk has a tracked issue URL or an existing-issue comment.

## Risk Assessment

- **Risk:** documentation drifts into restating CSS values or rule tables.
  **Mitigation:** both tasks explicitly require pointing at executable owners,
  matching the existing document style.
- **Risk:** filing a duplicate release-pipeline issue. **Mitigation:** Task 4.3
  requires a duplicate search first.
- **Risk:** breaking the docs-site build with a malformed link. **Mitigation:**
  the build gate in Success Criteria.

## Security Considerations

- No secrets, tokens, private URLs, or local absolute paths in either document or
  the follow-up issue.
- The follow-up issue describes a pipeline-ordering defect using only publicly
  documented workflow behavior.

## Next Steps

Proceed to Phase 5 (browser smoke, then ship to `main` and watch the deploy).

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
