# Dashboard design guidelines

Design system for the Cloud Harness operator dashboard. This document owns the
**why**; [`apps/api/dashboard/dashboard.css`](../apps/api/dashboard/dashboard.css)
owns the **what** (every token and rule). The static UI contract is enforced by
[`apps/api/test/dashboard-ui-contract.test.ts`](../apps/api/test/dashboard-ui-contract.test.ts).

## Direction

The dashboard is an **ops ledger**: a dark instrument **spine** (top bar and rail,
dark in both themes) framing a quiet ledger work surface. The content is ids,
leases, logs and states, which read best as ruled rows and monospace stamps, so
the spine carries identity and navigation and the work surface stays calm. It
replaced a graphite-on-graphite console whose rail, top bar, canvas and panels
sat within a few lightness steps of each other, so structure depended on
hairlines alone and nothing read first; and before that, the Cyber-Engineering
HUD, whose uppercase-everywhere grammar made every surface shout equally.

- **Register:** product (a tool an operator must trust). The bar is legibility and
  earned familiarity, not novelty.
- **Voice:** quiet, precise, sentence case. Colour is spent only on **state**: the
  accent marks the one next action and where you are; semantic hues mark status.
  Everything else is graphite.
- **Dials:** variance 3, motion 3, density 6. Motion confirms an arrival or a
  state change (140-220ms); nothing decorative, nothing looping but the skeleton.
- **Signature:** the spine frame, a monospace **path eyebrow** (`~/operate`,
  `~/admin`) above every page title, and the Overview **status strip**: the four
  decision tiles joined into one segmented strip whose 3px top rule is tinted by
  what each segment measures (attention, running, cost, expiry). Attention and
  expiry turn loud (`.has-alert`) only when they hold something to act on, so a
  quiet console reads as quiet.
- **Hierarchy of a page:** the eyebrow names the sidebar group the page lives in
  (set from the page registry by `selectNavigation`), the `h1` names the page, and
  the page's single primary action sits on the right of the same header row. A
  panel's leading `h2`/`h3` becomes a ruled header band, so each panel reads as a
  ledger section with its title on the rule.
- **No shell flash:** the header carries `data-shell-pending` and the command
  surface starts `hidden`, so the shell never paints a default "Overview" title or
  a workspace filter bar before the page registry sets the real ones.

## Relationship to the marketing site

The dashboard keeps the marketing site's **cyan accent hue** in dark and a blue
companion in light, so the product still reads as the same family. It no longer
copies the HUD's grammar. Constraints that shape what is possible:

- **No grid or glow backdrop.** The UI contract test rejects `gradient(`. Depth
  comes from a three-step surface ramp, hairlines, and one inset highlight.
- **No web fonts.** The CSP has no `font-src`, so the native `--font-sans` and
  `--font-mono` stacks carry everything.
- **Light-theme accent and semantic values are darker than the marketing hexes**,
  because the marketing light accents fail AA as pill and button text. The
  numbers are asserted by the contrast test.
- **The `-line` family is opaque**, while marketing tints its borders. See the
  `-soft` / `-line` split under Color.

## Hard constraints (do not violate)

- **No web fonts, no external assets, no inline styles.** The dashboard document
  is served under a strict CSP set by `dashboardSecurity` in
  `apps/api/src/dashboard-router.ts`: no `font-src`, so no self-hosted or web
  fonts, and no external assets, `style=` attributes, or storage. All styling
  lives in `dashboard.css`; behavior in the dashboard JS. The contract test
  asserts the absence of `@font-face`, `@import`, `url(`, and `style=`. One limit
  worth knowing: that middleware runs on the router mounted at `/dashboard`, which
  sits after `accessAssertionAuth` in `apps/api/src/app.ts`, so an unauthenticated
  401 from a dashboard path carries no CSP or `X-Frame-Options`.
- **OKLCH only.** No hex colors and no `gradient()` anywhere (the UI contract
  test rejects both). Note that CSS composites alpha on the encoded channel
  values, so a translucent tint over a near-black canvas is far darker than it
  looks on paper.
- **DOM is a contract.** Preserve the landmarks, single `<h1>`, dialogs, nav
  labels, and required CSS tokens/rules the contract test asserts.

## Typography (native stack)

- `--font-sans` system UI stack for body, headings, **and figures**. Metric values
  are sans at 650 weight with tight tracking and `tabular-nums`: a large figure
  reads faster in the UI face than in a monospace one.
- `--font-mono` only for identifiers and machine text: IDs, digests, versions,
  paths, code, and the `Updated` stamp.
- **Sentence case** for headings, buttons and tabs. Small labels — the path
  eyebrow, nav group labels (`/operate`), table heads, metric labels and status
  stamps — are **lowercase monospace**, so machine vocabulary reads as one
  register distinct from the prose, without shouting in uppercase.
- Fixed `rem` type scale (dense UI). Body 14px desktop, 16px on mobile (avoids
  input zoom). One family in multiple weights - no second display face.

## Color

- **Strategy:** dark-first graphite. The `:root` base is a near-neutral, faintly
  cool ramp (canvas, surface, raised, muted). The accent is used only for the
  primary action, the active nav rail and tab underline, selection, and focus,
  and stays under ~10% of any surface.
- **Cyan is the single accent.** `--accent` is the **fill** token: button and tab
  backgrounds, the active rail, borders, the focus ring. `--accent-strong` is the
  **text** token for links and emphasis. The bare `--accent` must never be used as
  a `color`, because as text it cannot reach AA on the light surfaces; the
  contrast test asserts that no `color: var(--accent)` exists at all.
- **Semantic hues are separated from the accent:** success green, warning amber,
  danger red, and an **info** tier (violet) for neutral in-progress states.
  Status is a pill with a leading dot. Amber survives only as `--warning`; it is
  no longer the accent.
- **`-soft` is a translucent fill; `-line` is an opaque border.** This split is
  load-bearing. `-soft` tints sit behind text and always pair with an opaque text
  colour or border. `-line` draws borders, instrument rules, and underlines, and
  must stay opaque: a translucent cyan line measures about 1.5:1 over the canvas
  and would effectively disappear. The contrast test asserts the whole
  `-line` family has no alpha component.
- **One gray family**, brand-tinted toward the console's cool blue.

### The spine

The top bar, rail and mobile drawer paint from a separate `--rail-*` token set
declared **only** in `:root`, so the spine stays dark in the light theme too. The
light work surface then reads as a sheet laid inside a dark frame, and the frame
never competes with content for attention. Spine text, the active-item marker and
the focus ring use the rail tokens rather than the page tokens, because page ink
is dark in light mode and would vanish on the spine.
[`apps/api/test/dashboard-design-tokens.test.ts`](../apps/api/test/dashboard-design-tokens.test.ts)
asserts that no light block redefines a `--rail-*` token and that spine text and
the accent clear AA on every spine surface.

### Adaptive dark theme

Dark is the **authoring base**: `:root` holds the dark graphite palette, mirroring
`site/index.html`'s `<html data-theme="dark">` foundation. Light is a companion
declared **twice**, because CSS cannot share one token set across a media query:
`:root[data-theme="light"]` for the forced choice and
`@media (prefers-color-scheme: light) { :root:not([data-theme]) { ... } }` for
`system`. Both blocks must be edited together, and
[`apps/api/test/dashboard-design-tokens.test.ts`](../apps/api/test/dashboard-design-tokens.test.ts)
asserts that their declaration sets are identical.

A single **icon control** in the top bar cycles system → light → dark; `system`
is represented by an absent `html[data-theme]`, so the media query governs again.
The four cases therefore all resolve: no attribute on a dark-preference machine
renders the base; no attribute on a light-preference machine renders the light
companion; and a forced `light` or `dark` always wins, because the media query is
scoped to `:root:not([data-theme])`. The control is deliberately **not**
`aria-pressed` — that attribute describes two states and this control has three,
so the accessible name states the current state and the next action instead.
Client storage is forbidden, so the choice persists **server-side, not in the
browser**: `PUT /api/v1/preferences` (CSRF-guarded) sets an HttpOnly
`ch-dashboard-theme` cookie, and the shell handler injects `html[data-theme]` on
first paint so a forced theme never flashes. The client only reads that DOM
attribute. Owners: the cycle state machine in `dashboard.js` and the injection in
[`apps/api/src/dashboard-assets.ts`](../apps/api/src/dashboard-assets.ts).

Both themes are verified at WCAG AA by
[`apps/api/test/dashboard-design-tokens.test.ts`](../apps/api/test/dashboard-design-tokens.test.ts):
body and muted text >= 4.5:1, primary-button text and every status pill pass
against their actual composited backgrounds, accent emphasis text passes on every
surface it lands on, and the accent line and focus ring clear 3:1. The light
accent and semantic values are deliberately darker and chroma-clamped relative to
the raw marketing light hexes, because those fail AA as pill and button text.

### Operator display name

The Profile page edits a cosmetic **display name** shown in the top-bar chip.
Client storage is forbidden, so it follows the theme's server-side pattern: the
same CSRF-guarded `PUT /api/v1/preferences` writes an HttpOnly
`ch-dashboard-display-name` cookie and `GET /api/v1/profile` returns it as
`preferences.displayName`. The value is a presentation-only override: it never
replaces the verified assertion, never authorizes anything, is validated against
a bounded pattern on write, is re-validated on read (a tampered cookie is ignored
rather than trusted), and is escaped like any other attacker-influenceable
value. Owner: [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts).

## Depth, shape, motion

- **One depth strategy:** hairline borders (`--line`, `--line-strong`) plus a
  one-pixel inset highlight (`--highlight`) on framed surfaces. Floating layers
  only (dialogs, menus, mobile drawer, toasts) carry `--shadow-overlay`.
- **One radius scale:** `--radius-sm/-md/-lg` (4/6/10px) plus `--radius-pill` for
  badges. Status pills are squared `--radius-sm` stamps, matching the ledger.
- **Density follows the pointer.** Controls declare the 44px floor
  (`min-height: 2.75rem` at the 16px mobile root) and `@media (pointer: fine)`
  tightens buttons, inputs, nav items, tabs, and table rows to a working desktop
  density; `--control-h` carries the same value for components that size to it.
- **One tab grammar.** Workspace cockpit tabs, Activity filters, Knowledge, MCP,
  and Skills tabs share one underline strip that scrolls sideways on narrow
  screens instead of wrapping.
- **Motion:** transition only `color`, `background-color`, `border-color`,
  `transform`, `box-shadow`, `opacity`; never `transition: all`. A route arrival
  rises into place (`#content > *`, decision tiles staggered by 30ms), dialogs
  scale in over a fading scrim, toasts slide in from the edge, and the badge pops.
  Every animation has the global `prefers-reduced-motion` off-ramp. Skeletons over
  spinners.

## Components

- **Data tables:** a dense table is paired with a card list of the same rows. The
table carries `desktop-table`, which the mobile breakpoint hides, **and** the card
list is hidden at base and returns only inside that same breakpoint — hiding one
side is not enough, because a card list with no base rule renders beside the table
and duplicates every row. Both renderings carry the same controls and both are
wired, so the visible one is never the only working one. Owners:
`renderWorkspaceIndex` and the Skills library's `renderSkillsLibraryRows` /
`renderSkillsLibraryCards` in `dashboard-render.js`, with the visibility pair in
[`dashboard.css`](../apps/api/dashboard/dashboard.css).
- **Skills page:** `/dashboard/skills` is four tabs — Library, Discover, Skill Sets,
  Registry — and each tab body is a plain layout container, so every surface inside
  it is a sibling framed element rather than a panel nested in a panel; the table
  keeps the single frame `.desktop-table` gives it. The tab strip marks the active
  tab through `[aria-selected="true"]`, which the tab controller already maintains,
  so the strip has no second source of truth. The Library's filter bar and the
  create/edit editor are `<form>` elements that declare their own grid, because the
  dashboard's global `form` rule lays form children out as one wrapping,
  end-aligned row, which reads as a single crowded line for a labelled filter bar or
  for a form. The detail panel is an in-flow `.drawer`, not a floating layer, so it
  takes a hairline frame and no shadow; it names the skill it opened and carries the
  close control, because a panel that only opens is a trap, and the revision diff
  renders inside it rather than in Discover, which is hidden whenever Library is
  open. The create and edit flow is one `<dialog>` placed outside the tab panels,
  opened by the page's single primary action and by the drawer's Edit control,
  because a dialog nested in a hidden panel does not render; the slug and display
  name are fixed while editing, since a revision carries the instructions only.
  The library has three exclusive states — rows, empty, and filtered to
  nothing — and only the two empty states state a reason and offer the single action
  that resolves them; the count is stated in every state, so a filter is never
  mistaken for an empty library. The library and each revision row state the version
  the revision declares, and a revision that declares none shows an explicit empty
  state rather than a blank cell, because a blank cell reads as a rendering fault
  rather than as an absent declaration; a save whose version does not advance reports
  a drift warning alongside the success announcement instead of refusing the revision,
  since a revision records what happened. Owners: `renderSkillsSkeleton`,
  `renderSkillsLibraryRows`, `renderSkillsLibraryCards`, `renderSkillRevisions`,
  `renderSkillsRegistryRows`, `renderImportJobGuidance` and
  `isTerminalImportState` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js);
  `skillsLibraryState`, `createSkillsLibraryController` and
  `createSkillsTabsController` in `dashboard.js`; the `.skills-*` and `.drawer`
  rules in [`dashboard.css`](../apps/api/dashboard/dashboard.css), pinned by
  `apps/api/test/dashboard-ui-contract.test.ts`.
- **Top bar:** sticky header carrying the wordmark + `MCP Control Plane` tag, a
  search trigger (`aria-keyshortcuts="Meta+K Control+K"`), the theme icon, the
  profile chip, and Sign out. The chip is a link to the Profile page showing the
  operator **display name** (or the verified sign-on name/email until one is
  set); Sign out is an icon-only Cloudflare Access logout at
  `/cdn-cgi/access/logout` with an accessible name and title, so the header
  carries identity rather than an account menu.
- **Command palette:** opened by the search trigger or `CMD+K` / `CTRL+K`. It
  indexes page commands plus an allowlisted projection from seven existing
  resource list endpoints, fetched in batches of at most three so it cannot
  exhaust the dashboard's per-principal concurrency budget, and bounded to 200
  entries per source and 50 rendered matches. It covers only the first page of
  each paginated resource, which the dialog states outright. Secret values,
  secret descriptions, and knowledge content are never indexed — `GET
  /api/v1/knowledge` returns full item content, so Knowledge keeps its own
  page-level search. Combobox/listbox semantics with `aria-activedescendant`;
  focus never leaves the input. Owners: `renderPaletteResults` in
  `dashboard-render.js`, and the index build, ranking, and batching in
  `dashboard.js`. `Escape`, the visible search trigger, and a tap or click on
  the backdrop all dismiss it (`dismissOnBackdrop` also ignores a drag that
  starts inside the dialog).
- **Navigation:** left icon+label rail, grouped by operator intent — **Home**
  (Overview), **Operate** (Workspaces, Agents, Activity, Approvals), **Configure**
  (Projects, Secrets, Models & Budgets, Skills, Integrations), **Data** (Knowledge,
  Artifacts), and **Admin** (API Access, Settings). Active item gets a raised spine
  fill and the cyan marker. Audit history has no rail slot: it is the Activity Center's Audit filter,
  a command-palette destination, and its own `/dashboard/audit` route. Profile
  deliberately has **no** rail slot: the top-bar profile chip and the
  command palette are its entry points. GitHub and MCP Servers are not rail
  entries either — they are tabs of the single **Integrations** page at
  `/dashboard/integrations`, with `/dashboard/github` and `/dashboard/mcp-servers`
  kept as redirects and `/dashboard/mcp-servers/:serverId` still serving a
  server's detail view. The rail is **fixed to the viewport below the top
  bar and scrolls internally**, so a long navigation list never pushes the page
  or hides entries; the rail foot carries the running **server version** outside
  that scroll and hides it when the rail collapses to icons. A chevron control
  collapses the rail to icons on desktop (toggling `.app-shell.nav-collapsed`);
  it also collapses to icons on tablet and to a drawer on mobile. The version is
  labelled "Server version" rather than "Release" because production runs the
  pre-version-bump commit, so the readout legitimately lags the newest tag by one
  release. Owners:
  [`apps/api/dashboard/dashboard-pages.js`](../apps/api/dashboard/dashboard-pages.js)
  owns page identity, route, label, group, heading, help, icon and palette
  membership, and the sidebar is rendered from it rather than authored in
  `index.html`; [`apps/api/src/dashboard-assets.ts`](../apps/api/src/dashboard-assets.ts)
  owns the shell path allowlist, the legacy redirects and the version injection,
  and `apps/api/test/dashboard-pages.test.ts` asserts the two lists stay in
  parity.
- **Overview and route ownership:** `/dashboard` **is** the Overview, and the
  workspace index lives at `/dashboard/workspaces`; `/dashboard/overview`
  redirects to `/dashboard`. Every other page keeps its existing path so links
  and bookmarks survive the reorganisation. Client route matching resolves
  through the page registry, and detail routes (`/dashboard/workspaces/:id`,
  `/dashboard/projects/:id`, `/dashboard/knowledge/:id`,
  `/dashboard/mcp-servers/:id`) stay owned by the page whose rail entry must
  remain current.
- **Overview:** the four-segment status strip above the fold (two by two below
  the tablet breakpoint), then
  Needs attention beside Expiring soon, the analytics grid, and Access beside Server.
  Each chart keeps its numbers table behind a `Show numbers` disclosure, and every
  bar carries a native `<title>` tooltip. The tiles
  and the feed read server-side read-only projections instead of fanning out in the
  browser: `GET /api/v1/overview` composes the decision buckets, `GET /api/v1/metrics`
  counts retained audit events inside a validated window, and `GET /api/v1/activity`
  composes the timeline. The Server panel reads `GET /api/v1/server`, a read-only
  projection of config and status that exposes no owner ID, runner URL, token, or
  secret.
- **Resource pages:** every global resource page (Projects, Global Secrets,
  Artifacts, API Access, Models & Budgets, Integrations) opens with the same
  shape — page title and help from the page registry, **exactly one** primary
  action in the shell's action slot next to the heading, an optional filter row,
  then the resource list. Creation and edit flows live in a `<dialog>` built from
  `renderFormDialog`, not in a permanent form under the list: the page's job is to
  show the resource, and the dialog carries the effect description, the cancel
  affordance and the live status line. Identifiers, generations and hashes are
  secondary metadata with a copy affordance (`renderCopyChip`), never the page's
  label. Destructive actions keep `confirmAction` and stay visually separated.
  Navigation runs through one seam, `dashboardNavigationPath` + `navigateTo` in
  `dashboard.js`, which refuses any target outside `/dashboard` so a rendered
  value can never become an off-site redirect. Owners:
  `renderResourcePage`, `renderPrimaryAction`, `renderFormDialog` and
  `renderCopyChip` in `dashboard-render.js`; `setPageActions`,
  `bindDialogOpeners` and `bindCopyAffordances` in `dashboard.js`.
- **Workspace Cockpit:** workspace detail is a cockpit, not a metadata page. The
  header carries what an operator decides on — repository, status, ref, network
  profile, lease posture and an attention count — with `Renew lease` as the single
  accented action, `Finalize workspace` beside it, and recover/close behind a
  `More actions` disclosure. A contextual tab row covers Summary, Agents, Runtime,
  Files, Git, Automation, Deploy, Artifacts and Activity; these are workspace
  sections, never global rail entries. Every one of the nine tabs is backed by a real
  adapter: Artifacts lists the retained snapshots whose own record names the workspace,
  and Activity renders that workspace's live and retained rows over the shared event
  grammar, so no tab shows a placeholder or an unfiltered global list. Summary
  reports only observable state (status, branch, attributable repository items,
  capabilities, network posture) and says "Not reported" for cost and budget
  rather than showing a zero that reads like a measurement. Attention reasons come
  from what the dashboard can actually observe (lease expiry thresholds, workspace
  failure, network quarantine, dirty Git when known); agent and task reasons join
  with the phases that expose them. Lifecycle actions use the phase-1 dialog and
  live-region machinery, and a missing context response degrades the Summary
  without hiding the header or the actions. Owners: `renderWorkspaceCockpitHeader`,
  `renderWorkspaceTabs`, `renderWorkspaceSummary`, `workspaceAttention` and
  `workspaceLeaseState` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js); the lifecycle
  adapters are `/api/v1/workspaces/:id/{context,lease-renew,recover,finalize}` in
  [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts) with
  projections in
  [`apps/api/src/dashboard-response.ts`](../apps/api/src/dashboard-response.ts).
- **Agents:** `/dashboard/agents` is the global control center, and the workspace
  cockpit's Agents tab renders the same body scoped to one workspace, so a filter
  and a fact mean the same thing in both places. The filter row carries the five
  dimensions the issue enumerates — status, workspace, model profile, parent agent and
  attention state — and every one is URL-backed, so a filtered view is shareable.
  Status, workspace and parent are applied by the runner contract; profile and
  attention are derived in the adapter from one shared predicate
  (`agentNeedsAttention`), so the filter and the rows it shows cannot disagree. The
  hierarchy is a nested list
  built from `parentAgentId` — a screen reader gets real nesting — with every agent
  also listed flat in a table that names its parent, so the non-graph fallback is
  always present. An agent whose parent is missing from the page attaches to the
  root instead of disappearing. Each agent shows status as text plus a semantic
  class, workspace, profile, age, TTL, tokens, cost and cost-budget utilization;
  a limit the runner never reported reads as "Not reported" rather than 0%, and
  an over-spend clamps at 100%. The detail view splits Overview, Usage, Logs and
  Messages; logs are the adapter's bounded projection (an oversized event is
  truncated with an explicit marker) and messages carry a client-generated
  idempotency key while cancel cascades to children behind a confirmation.
  Owners: `agentStatusLabel`, `budgetUtilization`, `agentTreeIndex`,
  `renderAgentHierarchy`, `renderAgentTable`, `renderAgentsIndex` and
  `renderAgentDetail` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js); the adapters
  are `/api/v1/agents*` and `/api/v1/workspaces/:id/agents` in
  [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts) with
  the agent projections in
  [`apps/api/src/dashboard-response.ts`](../apps/api/src/dashboard-response.ts).
- **Runtime:** the cockpit's Runtime tab shows what is actually executing: a task
  table with status, duration, exit code, dependencies and a bounded output
  disclosure, plus a cancel for every task that is not terminal; the task
  dependency graph as **internal SVG** layered by dependency depth, where each node
  writes its state and duration as text, carries a semantic `task-<status>` class,
  and is focusable so its full `aria-label` is reachable from the keyboard, with the
  task table beside it as the text fallback (a cycle or an edge to an unknown node
  cannot break the layout); and sessions as named, closeable rows whose output is
  read through a **read-only, bounded** call — the browser never supplies stdin, so
  the dashboard cannot become a terminal — with truncation stated in the panel.
  Owners: `taskStatusLabel`, `taskDuration`, `renderTaskList`, `taskGraphLayout`,
  `renderTaskGraph`, `renderSessionsPanel` and `renderRuntimePanel` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js); the adapters
  are `/api/v1/workspaces/:id/tasks/{graph,:taskId,cancel}` and
  `/api/v1/workspaces/:id/sessions{,/:id/io,/close}` in
  [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts), with
  the bounded task and session projections in
  [`apps/api/src/dashboard-response.ts`](../apps/api/src/dashboard-response.ts).
- **Git and Finalize:** the cockpit's Git tab keeps **Finalize** as the primary
  happy path — one confirmed action that stages, commits and pushes — and treats
  everything else as an advanced surface. The tab shows branch, upstream,
  ahead/behind, and staged / modified / untracked counts parsed from
  `git status --short --branch`, the changed-file list, a bounded staged or
  unstaged diff with an explicit truncation notice, recent commits, and worktrees
  inside a disclosure with their own create form. Advanced operations (fetch,
  fast-forward-only pull, checkout, branch, merge, rebase) live in one collapsed
  form, use the existing fenced contracts, and report conflicts back in place
  rather than resolving anything automatically. The staged/unstaged toggle is a URL
  parameter, so the view is shareable and the back button works. Owners:
  `parseGitStatus` and `parseWorktrees` in
  [`apps/api/src/dashboard-response.ts`](../apps/api/src/dashboard-response.ts);
  `renderGitStatus`, `renderGitDiff`, `renderGitLog`, `renderWorktrees`,
  `renderGitAdvanced` and `renderGitPanel` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js); the adapters
  are `/api/v1/workspaces/:id/git/*` and `/api/v1/workspaces/:id/worktrees` in
  [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts).
- **Automation and Deploy:** the workspace Automation tab puts the resolved skill set
  and the lifecycle hooks in one place. Hooks are grouped by the event that runs them
  — `on_workspace_open`, `post_checkout`, `pre_commit`, `post_commit`, `manual` —
  beside an ordered pipeline that states each stage and its hook count as text (no
  colour-only or connector-only meaning), and a stage with no hooks says so rather
  than disappearing. Activation and deactivation stay with the runner's manifest
  contract; the page runs only what is already active, and a skill script runs only
  when the operator names it, through the verified-bytes contract. The Deploy tab
  lists repository-defined targets with their working directory, last reported result,
  duration and failure detail, and states "Not reported" for a target the runner never
  reported on instead of showing a zero; running a target confirms first because
  deployments are external-effect operations. Owners: `HOOK_LIFECYCLE`,
  `groupHooksByLifecycle`, `renderHookPipeline`, `renderHooks`,
  `renderWorkspaceSkills`, `renderDeployPanel` and `renderAutomationPanel` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js); the adapters are
  `/api/v1/workspaces/:id/{skills,hooks,deployments}` and their guarded run routes in
  [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts).
- **Activity and Approvals:** `/dashboard/activity` is one operational timeline with
  filters for All / Agents / Tasks / MCP / Deployments / Audit, and one event grammar
  — when, category, status, actor/resource, a short summary and where to look next.
  Every row states whether it is **Retained audit** or **Live runtime**, because audit
  is the durable spine while agent, task and deployment state is volatile; the two are
  never presented as the same kind of record. `/dashboard/approvals` is an inbox of
  pending privilege grants showing the requested command, workspace, working
  directory, command digest, created and expiry times, with Approve and Reject behind
  a confirmation that says the decision is audited. The rail shows a pending count
  **only while something is pending**, and an empty inbox explains what it means. Audit
  history left the rail in this phase and is reachable through the Activity filter, the
  command palette, and its own route. Owners: `ACTIVITY_FILTERS`, `activityEvent`,
  `renderActivityCenter` and `renderApprovals` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js); the loaders and
  the badge (`updateApprovalsBadge`, `refreshApprovalsBadge`) live in `dashboard.js`
  over the existing `/privilege-grants` and `/audit` routes.
- **Decision Overview:** `/dashboard` answers four operator questions above the fold —
  **Needs attention**, **Running now**, **Cost**, **Expiring soon** — and every tile is
  a link into the filtered view that explains it — attention →
  `/dashboard/agents?attention=needs-attention`, running and cost →
  `/dashboard/agents?status=RUNNING`, expiry → `/dashboard/workspaces?expiring=60`.
  Access and Server information moved
  below the decision metrics, and the old inventory tiles are gone. The page reads one
  server projection instead of fanning out: `GET /api/v1/overview` composes attention
  reasons (failed or quarantined workspaces, leases inside 15 minutes, failed /
  limit-exceeded / timed-out agents, pending approvals), running counts, a cost figure
  whose `scope` **names what was measured** ("running agents" — the harness retains
  per-agent usage, not a daily ledger, so no "today" claim is made), and expiry buckets
  at 15 minutes, 1 hour and 4 hours. `GET /api/v1/metrics?window=1h|24h|7d` counts
  retained audit events inside a validated window (an unsupported window is a 400) and
  states its scope in the response, and `GET /api/v1/activity` composes the Activity
  timeline server-side, marking live runtime rows apart from retained audit rows.
  Owners: `buildOverviewProjection`, `buildMetricsProjection`,
  `buildActivityProjection` and `METRIC_WINDOWS` in
  [`apps/api/src/dashboard-response.ts`](../apps/api/src/dashboard-response.ts); the
  routes live in [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts);
  `renderOverview` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js).
- **Analytics:** the Overview's Analytics section carries the eight decision charts, all
  internal SVG with focusable marks, accessible names, non-colour-only categories and a
  table fallback per figure, and no external chart dependency:
  - the **execution health timeline** — retained agents bucketed by start time and split
    into succeeded / failed-or-limit / cancelled / running, answering "is execution health
    degrading?";
  - the **cost trend** — the same buckets summing each retained agent's
    `usage.costMicros`, answering "is spend rising unexpectedly?";
  - **cost and tokens by model profile**, **budget burn of running agents**, **workspace
    expiry buckets**, and **MCP reliability per server** (calls, errors and p50/p95 from
    gateway traces) — plus the **task DAG** in the Runtime tab and the **agent hierarchy**
    in Agents.
  Because the harness keeps agent state and per-agent usage but no dated outcome or
  billing ledger, the two series charts state the scope they measured in their captions
  ("retained agents, bucketed by start time") and the section says so in prose, rather
  than implying a daily history the data cannot support. Owners: `renderStackedBars`,
  `renderBarChart`, `renderBarRows` and `renderAnalyticsSection` in
  [`dashboard-render.js`](../apps/api/dashboard/dashboard-render.js);
  `buildOverviewProjection` (`agentOutcomes` / `costSeries`) and
  `buildMetricsProjection` (`series`) in
  [`apps/api/src/dashboard-response.ts`](../apps/api/src/dashboard-response.ts).
- **Motion:** motion exists only to convey a state change, inside the 150-250ms band
  (`--motion-fast` / `--motion-state` with `--ease-out`): a mutation crossfades the
  region it re-rendered (`.content-just-updated`), a save moves from `Saving…` to a
  `Saved` state on the status line (`data-save-state`), a copy affordance flips to
  `Copied`, lease posture gains a rule and weight at its thresholds (`.lease-soon`,
  `.lease-expired`), chart marks and task/agent nodes show a focus ring and transition
  their stroke, disclosures colour their summary when open, and the detail drawer
  slides and fades. There is exactly one infinite animation — the loading skeleton —
  and no decorative or page-load choreography. The global
  `@media (prefers-reduced-motion: reduce)` block collapses every animation and
  transition to 0.01ms with `animation-iteration-count: 1`, so the preference is
  honoured everywhere by construction rather than per rule.
- **Tables:** rounded hairline container, lowercase monospace column heads, row hover,
  tabular numerals, `nowrap` timestamps; collapse to stacked cards on mobile.
- **MCP Servers:** the section lists a principal's downstream MCP servers with
  transport, status, cached tool count, last connected, and enabled state, and
  offers add, edit, enable/disable, Test, Refresh tools, delete, and a detail
  view with Overview / Tools / Permissions / Logs. Its gateway card shows the one
  copyable `/mcp-gateway` endpoint, names the credential lane the endpoint
  actually accepts (owner bearer or Access session), states that the managed
  API-key lane is not yet available, and lists the two hard limitations an
  operator hits first: HTTP redirects are refused, and `stdio` downstream
  servers are unsupported. Owners: `renderMcpGatewayCard` and
  `renderMcpServersIndex` in `dashboard-render.js`, and the MCP server routes in
  [`apps/api/src/dashboard-gateway-router.ts`](../apps/api/src/dashboard-gateway-router.ts).
- **Interaction states:** every control ships default / hover / `:focus-visible`
  / active / disabled; touch targets >= 44px (small controls expand their hit
  area via `::before`); inputs >= 16px.
- **Footer:** the shell ends every route with one global footer crediting
  AgentKit (`https://agentkit.best`). It is authored once in the shell rather
  than per page, so a new view inherits it automatically.

## Security in the UI

Never render runner tokens, owner IDs, container names, workspace paths,
provider credentials, or secret values. Secret references are write-only. API
keys are shown once and never persisted in the DOM or storage. Escape every
attacker-influenceable value.

## Changing the design

Edit `dashboard.css` (and the dashboard JS/render only when structure must
change). Keep the contract tokens and rules the UI test asserts, run
`npx vitest run dashboard`, then `npm run verify`, and re-check both light and
dark themes plus 375px in a browser before shipping.

Three extra gates apply to specific kinds of change:

- **A colour change** must be re-verified by
  [`apps/api/test/dashboard-design-tokens.test.ts`](../apps/api/test/dashboard-design-tokens.test.ts),
  which asserts every text, pill, emphasis, accent-line, and focus pair in both
  themes. If you touch a `-line` token, keep it opaque; if you touch a `-soft`
  token, keep it translucent.
- **A spacing change** must keep every `--space-*` step a member of the marketing
  scale, which the contract test asserts.
- **A light-theme change** must be applied to **both** light blocks. They are
  duplicated because CSS cannot share a token set across a media query, and the
  contrast test fails if they diverge.
