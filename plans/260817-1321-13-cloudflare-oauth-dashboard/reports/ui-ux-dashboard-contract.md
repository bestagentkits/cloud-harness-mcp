# Phase 2 dashboard UI/UX contract

## Decision summary

Implement an operator product dashboard, not a marketing page or generic SaaS admin. The selected direction is locked: seed 259, selected row 9/10, variance 3, motion 2, density 6. The visual thesis is a Cloudflare-like control plane made quieter and more code-oriented: cool off-white canvas, near-black ink, rare cobalt accent, compact neo-grotesque typography, and data-first composition.

The memorable element is the **workspace lifecycle rail**. It must be built from real workspace fields (`createdAt`, `lastActivityAt`, `expiresAt`, `status`) and never imply an event or timestamp the API does not supply.

Use three structural patterns:

- collapsible navigation sidebar;
- contextual command surface for search, filtering, refresh, and the one relevant primary action;
- workspace detail drawer on wide screens, promoted to a dedicated detail view on narrow screens.

Do not use page-load choreography, glass, gradients, hero typography, metric-card grids, fake charts, decorative terminal output, or sample workspace data. State changes may animate for 150–250 ms. The UI is useful before it is branded.

## Product boundary

Audience: one owner or mutually trusted operators in one security domain. This UI does not communicate hostile multi-tenant safety.

Phase 2 browser capabilities are bounded to the same-origin BFF contract:

- inspect workspace lifecycle and current repository/runtime summaries;
- inspect current tasks and named coding sessions;
- list and read bounded workspace files;
- write, patch, move, create, and delete workspace files with preconditions;
- close a workspace through the internal generation-fenced operation;
- expose no exec, shell, deployment, host path, Docker, bearer, Access assertion, runner token, or provider credential surface.

Project, environment, secret, GitHub installation, persistent artifact, and audit controls belong to Phase 3. Reserve clear navigation insertion points, but do not render empty cards or pretend those records exist in Phase 2.

## Information architecture and URLs

Use addressable URLs so refresh, browser Back, and deep links preserve operator context:

```text
/dashboard                         workspace index
/dashboard/workspaces/:workspaceId workspace detail
/dashboard/workspaces/:workspaceId/files?path=<encoded-relative-path>
/dashboard/workspaces/:workspaceId/runtime
```

`path` is display/navigation state only; the BFF still validates a workspace-relative path. Filters may use `?status=` and `?q=`. Do not put CSRF material, identity claims, repository credentials, file content, or opaque response tokens in URLs.

Primary navigation for Phase 2:

1. Workspaces
2. Files, only within a selected workspace
3. Runtime, only within a selected workspace

Phase 3 may add Projects and Activity at the top level. Unavailable destinations are omitted, not shown as dead teaser cards.

## Page anatomy

### Wide screen, 1180 px and above

```text
┌──────────────┬─────────────────────────────────────┬──────────────────────┐
│ Product/nav  │ Header + contextual command surface │ Workspace detail     │
│ 224 px       ├─────────────────────────────────────┤ drawer 400–440 px    │
│ collapsible  │ Workspace table                     │                      │
│ to 64 px     │ selected row is quiet cobalt tint   │ lifecycle rail first │
│              │                                     │ then facts/actions   │
└──────────────┴─────────────────────────────────────┴──────────────────────┘
```

- App shell uses `min-height: 100dvh`; only one document scroll region.
- Sidebar is 224 px expanded, 64 px collapsed. Persist only the presentation preference, never identity or auth state.
- Main column has `min-width: 0`; use a maximum readable width only for prose, not the workspace table.
- Detail drawer is part of the responsive grid, not a floating card. It has a 1 px left border and no drop shadow while docked.
- Selected workspace remains visibly selected when focus moves into the drawer.

### Medium screen, 768–1179 px

- Sidebar defaults to 64 px with icon plus accessible name; expansion overlays the main canvas.
- Workspace list remains the main view.
- Detail drawer overlays from the inline end at `min(420px, 92vw)` and traps focus only while modal.
- Opening and closing the drawer preserves list scroll and returns focus to the invoking workspace link.

### Narrow screen, 375–767 px

- Replace the sidebar with a 56 px top bar and a labelled **Menu** button; navigation opens as a modal sheet.
- Workspace index and workspace detail are separate URL-backed views. Do not layer two drawers.
- Command surface wraps to two rows: title/status count first, search and actions second.
- Workspace table becomes a semantic list of compact records. Each record shows repository, state, expiry, and last activity. Do not horizontally scroll the page.
- File lists use name as the first line and size/type/modified metadata as the second. Code content may scroll horizontally inside its own `<pre>`, while the viewport remains fixed.
- Sticky action bars include `padding-bottom: env(safe-area-inset-bottom)`.
- All interactive targets are at least 44×44 px even when the visible control is compact.

The contract must work at exactly 375 px CSS width at 200% zoom without loss of content or action.

## Semantic HTML contract

Use native semantics before ARIA:

```html
<a class="skip-link" href="#main">Skip to workspace content</a>
<div class="app-shell">
  <aside aria-label="Product navigation">…<nav aria-label="Primary">…</nav></aside>
  <main id="main" tabindex="-1">
    <header>…page title and contextual actions…</header>
    <form role="search" aria-label="Filter workspaces">…</form>
    <section aria-labelledby="workspace-list-heading" aria-busy="false">…</section>
  </main>
  <aside aria-labelledby="workspace-detail-title">…selected workspace detail…</aside>
</div>
```

- Use one `h1` per route. Detail drawer title is `h2` when docked and `h1` on its dedicated mobile route.
- Desktop data uses `<table>` with `<caption>`, `<thead>`, `<tbody>`, and row-header `<th scope="row">`. The repository name is a real link; do not make `<tr>` itself interactive.
- Mobile records use `<ul>`/`<li>` with a heading link and `<dl>` metadata.
- Workspace facts, resource limits, and repository metadata use `<dl>`.
- Lifecycle rail uses `<ol aria-label="Workspace lifecycle">`; its visible labels and timestamps are readable without color.
- Tabs, if used for Overview / Files / Runtime, follow the ARIA tabs pattern with arrow-key navigation. On narrow screens prefer normal links, not a horizontally clipped tab strip.
- File content is `<pre><code>` for read mode and a labelled `<textarea spellcheck="false">` for edit mode. Do not build a custom editor in Phase 2.
- Confirmation is a native `<dialog>` when support is acceptable, otherwise an equivalent accessible modal. It has a labelled title, description, Cancel, and explicit destructive action.
- Status announcements use one persistent `aria-live="polite"` region. Blocking request errors use `role="alert"`. Toasts never steal focus.

On route change, focus `#main`; on drawer open, focus its heading; on drawer close, restore the invoking link. Escape closes modal drawers/dialogs, never a docked drawer.

## Visual tokens

Use CSS custom properties. Components consume semantic tokens, never raw colors. Values are an implementation baseline; automated contrast checks own final acceptance.

```css
:root {
  color-scheme: light;

  --canvas: oklch(0.965 0.008 250);
  --surface: oklch(0.992 0.003 250);
  --surface-raised: oklch(1 0 0);
  --surface-muted: oklch(0.935 0.010 250);
  --ink: oklch(0.205 0.018 255);
  --ink-muted: oklch(0.455 0.025 255);
  --ink-faint: oklch(0.585 0.020 255);
  --line: oklch(0.865 0.014 250);
  --line-strong: oklch(0.740 0.024 250);

  --accent: oklch(0.515 0.218 259);
  --accent-hover: oklch(0.455 0.218 259);
  --accent-soft: oklch(0.925 0.038 259);
  --on-accent: oklch(0.985 0.006 250);
  --focus: oklch(0.610 0.190 250);

  --success: oklch(0.455 0.125 151);
  --success-soft: oklch(0.935 0.040 151);
  --warning: oklch(0.555 0.135 75);
  --warning-soft: oklch(0.945 0.045 75);
  --danger: oklch(0.505 0.190 28);
  --danger-hover: oklch(0.445 0.185 28);
  --danger-soft: oklch(0.940 0.045 28);

  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --text-11: 0.6875rem;
  --text-12: 0.75rem;
  --text-14: 0.875rem;
  --text-16: 1rem;
  --text-20: 1.25rem;
  --text-28: 1.75rem;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;

  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --shadow-overlay: 0 16px 48px oklch(0.20 0.02 255 / 0.16);
  --motion-fast: 150ms;
  --motion-state: 220ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Typography rules:

- No external font request. Use the repo-safe system stack above. A non-system display face is allowed only if bundled, licensed, self-hosted, and verified to contain Vietnamese glyphs; it is not required for Phase 2.
- Body and input text are 14 px on desktop, 16 px on narrow screens to avoid mobile input zoom. Supporting labels may be 12 px; never use 11 px for essential content.
- Headings use 600–700 weight and modest negative tracking (`-0.015em` maximum). Body copy uses normal tracking.
- IDs, SHA values, paths, timestamps, resource values, and counts use the mono stack with tabular numbers.
- Preserve full values through wrapping, copy controls, or an accessible disclosure. Truncation may not be the only way to retrieve an identifier.

Visual rules:

- Accent is reserved for current navigation, selected workspace, focus, and the primary non-destructive action. Status colors do not borrow cobalt.
- Use borders and surface shifts before shadows. Only modal overlays use `--shadow-overlay`.
- Radius stays 4–12 px. No pill-shaped containers except compact status badges.
- One consistent 1.75–2 px stroke SVG icon family; no emoji and no icon-only control without an accessible name.

## Workspace index

### Header and command surface

Header content:

- eyebrow: `CONTROL PLANE`;
- `h1`: `Workspaces`;
- helper: `TTL-limited coding environments available to your signed-in identity.`

Command surface is a bordered toolbar, not a command terminal. It contains:

1. labelled search input, placeholder `Filter by repository or workspace ID`;
2. status filter with `All`, `Creating`, `Active`, `Reaping`, `Closed`, `Failed`;
3. `Refresh` secondary button with last successful refresh time nearby;
4. any primary create/open action only if Phase 2 exposes a real, bounded BFF endpoint. Otherwise omit it.

Do not add an ornamental `⌘K` palette. If a global shortcut is later added, it must be documented, remappable or non-conflicting, and have an equivalent visible control.

### Desktop table

Columns, in priority order:

1. Repository — host-safe display name plus full sanitized URL disclosure;
2. State — text badge and icon;
3. Last activity — localized relative text with exact ISO time in accessible disclosure;
4. Expires — countdown text plus exact time;
5. Network — `No network` or `Bridge enabled`;
6. Actions — labelled overflow button.

Use a 44 px minimum row height. The selected row uses `--accent-soft`, a 3 px inline-start accent rule, and `aria-current="true"` on its detail link. Hover alone must not communicate selection.

Workspace IDs are secondary. Never show `ownerId`, container name, workspace path, generation, or internal principal ID.

### Status language

| API state | Label | Supporting copy | Treatment |
|---|---|---|---|
| `CREATING` | Creating | `Repository and executor are being prepared.` | neutral spinner + text |
| `ACTIVE` | Active | `Workspace is ready for bounded operations.` | success dot + text |
| `REAPING` | Closing | `Executor and workspace files are being removed.` | warning/progress + text |
| `CLOSED` | Closed | `This workspace is no longer available.` | neutral outline + text |
| `FAILED` | Failed | sanitized server error, then recovery guidance | danger icon + text |

Never use `Healthy`, `Secure`, or `Isolated` as inferred status labels. `bridge` must be visibly called `Bridge enabled` with warning copy: `Executor network access is enabled for this workspace.`

## Workspace detail and lifecycle rail

Drawer header:

- repository display name as title;
- workspace ID with Copy button;
- status badge;
- close button with accessible name `Close workspace details` when modal.

The lifecycle rail is the first detail section:

```text
● Created        exact createdAt
│
● Last activity exact lastActivityAt
│
○ Expires        exact expiresAt / “Expired” only when now >= expiresAt
```

- Use an ordered list with labelled points, not a chart library.
- Use a solid current marker and outlined future/end marker; pair shape with text.
- Update countdown text at most once per minute unless less than five minutes remain, then at most once per second. Announce only threshold changes (`5 minutes remaining`, `Workspace expired`), not every tick.
- `CLOSED` and `FAILED` are status overlays on the rail. Do not fabricate `closedAt` or `failedAt`.
- When server time or expiry certainty is unavailable, show the exact timestamp without a countdown.

Below the rail, use compact `<dl>` sections:

- Repository: sanitized URL and ref or `Default branch`;
- Runtime: network mode, resource limits only when supplied by the BFF, current task count, current named-session count;
- Lifecycle: created, last activity, expiry;
- Data notes: `Current tasks and sessions are volatile and may disappear after a runner restart.`

Primary drawer actions are links to `Files` and `Runtime`. `Close workspace` is separated at the bottom in a danger zone; it is never in the row’s default action position.

## Files surface

- Breadcrumb starts with `Workspace root`; each segment is a link. Never display a host path.
- File list columns: Name, Type, Size, Modified only when the response owns those fields, and Actions. Missing metadata means omit the column, not `0` or `Unknown` repeated in every row.
- Directory navigation and file selection are links. Mutation controls are explicit buttons/menu items.
- Read mode shows path, bounded range, SHA/ETag, truncation state, and content.
- `Load next segment` is explicit when bounded content remains. Concatenate only after a successful response; preserve the current segment if fetching the next fails.
- Edit mode uses a labelled textarea and displays `Editing version <short SHA>`. Save sends the exact precondition received with the content.
- Patch UI, if exposed, uses two labelled inputs: `Text to replace` and `Replacement text`; it is not a diff editor.
- Move has visible Source and Destination labels. Create folder has a visible Name/Path label. Delete states the exact workspace-relative target.
- A file conflict never overwrites silently. Keep unsaved content in memory and offer `Review latest version`, `Copy my changes`, and `Cancel`; do not offer force-save unless a separate accepted contract explicitly permits it.

Redaction/truncation indicator:

- show a shield/slash icon plus visible `Redacted` only when the response explicitly marks a field/content as redacted;
- show `Output truncated` when the response has `truncated: true`, with recovery guidance;
- tooltip text alone is insufficient;
- never infer or visually redact arbitrary source text in the browser;
- never render secret values, credential-like placeholders, or a reveal action.

## Runtime surface

Use two dense sections, Tasks and Named sessions. No terminal emulator and no command input.

Task fields: opaque task ID, status, exit code when supplied, dependencies when supplied. Session fields: name, opaque session ID, status. Status vocabulary is exactly `Queued`, `Running`, `Succeeded`, `Failed`, `Cancelled`, `Blocked`.

- Current/volatile data carries the visible label `Current runtime state` and note `Not retained across runner restart.`
- Output is not shown in a list row. If bounded output is exposed in a read-only detail, use `<pre>` and explicit truncation/cursor state.
- Do not display raw command strings in summaries unless the BFF contract explicitly permits and bounds them.
- Empty copy: `No current tasks.` and `No named sessions.` These are valid states, not errors.

## Loading, empty, error, and expired states

| Condition | Visible copy | Required action/behavior |
|---|---|---|
| Initial load | `Loading workspaces…` | structural skeleton without fake text; `aria-busy=true` |
| Background refresh | `Refreshing…` | keep existing data; non-blocking live announcement |
| No workspaces | `No workspaces yet.` / `Open one from an MCP client and it will appear here.` | no create CTA unless endpoint exists |
| No filter result | `No workspaces match these filters.` | `Clear filters` |
| Recoverable request error | `Workspaces could not be loaded.` | `Try again`; retain safe stale data and label it `Last updated …` |
| Offline/network loss | `Connection lost. Displayed data may be out of date.` | `Retry` when connectivity returns |
| Unauthorized/session ended | `Your dashboard session ended.` | `Sign in again`; clear sensitive in-memory UI state |
| Forbidden/foreign/missing | `Workspace not found or no longer available.` | return to Workspaces; do not reveal ownership |
| Expired | `Workspace expired.` / `Files and runtime operations are no longer available.` | disable mutations; return to Workspaces |
| Optimistic conflict | `This item changed after you opened it.` | refresh/review latest; preserve local edit |
| Rate limited | `Too many requests. Try again in {duration}.` | respect retry metadata; no tight auto-retry |
| Service unavailable | `The workspace service is temporarily unavailable.` | manual retry, preserve context |
| Truncated | `Only part of this result is shown.` | bounded next-segment action when supported |

Skeletons reserve the final layout and use no simulated repository names, metrics, or statuses. After 10 seconds, add `This is taking longer than expected.` with Retry. Loading indicators are not announced repeatedly.

## Destructive confirmation contract

Destructive actions are Close workspace, Delete file/folder, and overwriting move only when the contract allows it.

Close dialog:

- title: `Close workspace?`;
- body: `This stops the executor and removes the workspace checkout. This cannot be undone.`;
- target: sanitized repository name and workspace ID;
- secondary: `Cancel`;
- destructive: `Close workspace`.

Delete dialog:

- title: `Delete {file|folder}?`;
- body includes exact workspace-relative path;
- recursive folder deletion adds: `This removes the folder and all contents from this workspace.`;
- destructive: `Delete {file|folder}`.

Focus starts on Cancel. Enter does not trigger the destructive action unless that button is explicitly focused. During submission, disable both repeated mutation and dismissal, label progress (`Closing…`, `Deleting…`), then return focus to the nearest stable heading/list after success. A stale generation/ETag displays the conflict state and never claims success.

## Interaction and motion

- No route/page entrance animation, stagger, parallax, shimmer sweep, or count-up.
- Hover/focus/pressed color transitions: 150 ms.
- Sidebar/drawer transform and opacity: 220 ms, `--ease-out`; exits may use 150 ms.
- Animate only `transform` and `opacity`. Docked grid changes may snap rather than animate width.
- Loading spinner is the only continuous motion. Under reduced motion, use a static progress glyph plus text.
- Interaction feedback appears within 100 ms and never blocks input for animation completion.
- Refresh does not reset selection, focus, filters, scroll position, or an unsaved edit.

## Keyboard and focus acceptance

- First Tab reveals Skip link.
- Tab order follows sidebar → header/command surface → workspace content → docked detail.
- Sidebar collapse control is a real button with `aria-expanded` and an accessible name that changes between `Collapse navigation` and `Expand navigation`.
- Workspace selection is reachable through its link; no click-only row behavior.
- Modal nav/detail drawers and confirmation dialogs trap focus, support Escape, and restore focus.
- Native table/list scrolling never traps arrow keys. Tabs use Left/Right only when focus is within the tablist.
- Focus indicator is at least 2 px with a 2 px offset and remains visible against canvas, surface, accent, danger, and selected-row backgrounds.
- Disabled controls use the native `disabled` attribute where applicable and are not the only source of explanatory copy.
- Status, selection, redaction, expiry, and destructive state are not communicated by color alone.

## Copy and data rules

- Use operator language: workspace, repository, ref, task, session, file, lifecycle, expiry, network mode.
- Say `Close workspace`, not Delete workspace; say `Delete file/folder` for checkout mutations.
- Use `No network` for `none`, and `Bridge enabled` for `bridge`.
- Dates are localized for display and retain exact ISO values in `<time datetime>` or accessible detail.
- Relative times never replace exact times.
- Repository URLs must be sanitized and credential-free before reaching the browser.
- Error details are BFF-sanitized. Do not render stack traces, host paths, container names, control-plane IDs, tokens, or raw provider responses.
- Avoid success claims such as `Secure`, `Protected`, or `Fully isolated`; the executor is bounded but shares a kernel.

## Implementation-ready component boundaries

Suggested focused units; names may follow the repo's actual convention:

- `DashboardShell`: landmarks, sidebar/top bar, route focus;
- `WorkspaceCommandSurface`: search, status filter, refresh;
- `WorkspaceTable` and `WorkspaceList`: one data model, responsive renderers;
- `WorkspaceStatus`: icon + text + semantic tone;
- `WorkspaceDetail`: drawer/dedicated route composition;
- `WorkspaceLifecycleRail`: actual timestamps and expiry thresholds;
- `FileBrowser`, `FileReader`, `FileEditor`, `FileMutationDialog`;
- `RuntimeSummary`: task/session lists and volatile-state notice;
- `AsyncBoundary`: loading, stale, empty, error, retry semantics;
- `RedactionNotice` and `TruncationNotice`;
- `ConfirmDestructiveAction`.

Keep state ownership simple: URL owns route/filter/path, fetch layer owns server data and preconditions, component-local state owns only disclosure/drawer state and unsaved textarea content. Do not persist response payloads or file content in browser storage.

## Verification checklist

- Automated checks assert landmarks, one `h1`, accessible names, heading order, table/list semantics, live regions, dialogs, and no empty links/buttons.
- Keyboard test covers select workspace → open modal drawer → Files → edit conflict → cancel → close confirmation → focus restoration.
- Viewport tests cover 375, 768, 1024, and 1440 px; no page-level horizontal overflow.
- Test 200% zoom and browser text scaling without clipped content.
- Test `prefers-reduced-motion: reduce`; no transition or spinner is required to understand state.
- Test every workspace state and every task/session state using contract fixtures, not fabricated production-like records.
- Test loading, empty, filtered-empty, stale-data error, offline, unauthorized, foreign/missing, expired, conflict, rate-limit, unavailable, redacted, and truncated states.
- Test contrast for all text/token pairings (4.5:1 normal, 3:1 large text and meaningful non-text UI), including focus and selected states.
- Test 44×44 px targets at 375 px.
- Test browser HTML, JS state, DOM, URL, storage, console, and network responses contain none of the forbidden credentials or host/control-plane fields.
- Test bearer mode returns no dashboard/login/session UI.

## Design rationale and rejected patterns

The UI skill's generic search suggested an immersive, exaggerated-minimal landing pattern with oversized typography and external Google fonts. That output conflicts with the locked operator-product direction, density 6, motion 2, no external-font dependency, and the repository's data/security boundaries; it is intentionally rejected. The useful skill constraints retained here are semantic structure, keyboard access, 44 px targets, explicit feedback, 150–250 ms state motion, reduced motion, responsive breakpoints, and non-color state communication.

## Unresolved questions

None for the Phase 2 UI contract. The implementation must omit any create/open workspace CTA or Phase 3 destination until its actual BFF contract exists.
