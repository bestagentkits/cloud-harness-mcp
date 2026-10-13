# Dashboard redesign — "Ops ledger"

Mode: `--auto --loop 3`. Target: `apps/api/dashboard/` (operator console served at
`/dashboard`). Production: https://harness.zuey.me/dashboard (v0.61.0 at baseline).

## Scope and environment

- Stack: vanilla ES modules + one stylesheet under a strict CSP (`style-src 'self'`,
  no web fonts, no inline style, OKLCH-only colour, contract tests pin tokens and
  selector strings).
- Baseline evidence: production via Claude in Chrome (1921×1086 CSS px, dark), read-only
  GET of the dashboard API. Secrets/API-key/model pages were not captured (credential
  material); they are checked visually only after deploy.
- Local preview: the real `createDashboardRouter` + `createDashboardAssetsRouter` from
  `apps/api/dist` with a fake runner in the session scratchpad (not committed), rendered
  in the built-in browser at 1440×900, 768×1024, 375×812, dark and light.
- AX / discovery scan: not applicable — the console sits behind Cloudflare Access and is
  not a public, crawlable surface. Recorded as N/A, not as a pass.

## Baseline findings (production)

| # | Evidence | Finding |
|---|---|---|
| B1 | `/dashboard/agents` | "Workspace not found or no longer available." + stuck "Loading…": global `agent_list` without `workspaceId` resolves to the single active workspace in the runner. |
| B2 | `GET /api/v1/metrics`, `/api/v1/activity` | `invalid_request: Too big: expected number to be <=100` — `audit_list` / trace reads asked for 200 rows. Overview analytics and Activity silently empty. |
| B3 | every route before JS | Shell paints "Overview" + the workspace filter bar, then swaps: title flash and layout jump. |
| B4 | 1920 viewport | Content capped at 90rem and centred: wide dead gutters, rail and content feel disconnected. |
| B5 | Overview | Four floating tiles + many same-weight panels; hierarchy is flat, nothing reads first. |
| B6 | global | Graphite-on-graphite surfaces: rail, topbar, canvas and panels are within ~0.05 L of each other, so structure relies on hairlines only. |

## Rubric (baseline → target)

| Area | Base | Target | Evidence |
|---|---|---|---|
| Brand recall | 2 | 3 | generic graphite console; no signature beyond a 2px tile rule |
| First impression | 2 | 3 | B3, B5 |
| Hierarchy | 2 | 3 | B5, B6 |
| Responsive | 3 | 3 | existing tablet/mobile blocks are sound |
| Trust / correctness | 1 | 3 | B1, B2 (visible errors and false empties) |
| Motion | 3 | 3 | state-only motion, reduced-motion honoured |
| Accessibility | 3 | 3 | AA tokens pinned by tests |

## Design brief

```text
Register:  Product
Scene:     One owner-operator checks remote coding workspaces and agents from a desktop
           browser between coding sessions (sometimes a phone), scanning for what failed,
           what is running, and what is about to expire.
Direction: "Ops ledger" — a dark instrument spine (topbar + rail, dark in both themes)
           framing a quiet ledger work surface, because the content is ids, leases,
           logs and states that read best as ruled rows and mono figures.
Color:     Restrained; dark bg oklch(0.150 0.008 250), ink oklch(0.965 0.004 250),
           accent cyan oklch(0.800 0.125 208) (light: oklch(0.520 0.150 245)).
Type:      system grotesque + ui-monospace; contrast axis: grotesque vs mono
           (mono carries ids, figures, table heads, state stamps and the path eyebrow).
Signature: the spine frame + mono path eyebrow (`~/operate`) + a segmented status
           strip on Overview whose top rule is coloured per signal.
Dials:     variance 3, motion 3, density 6
```

## Proposals

| Rank | Proposal | Files | Acceptance check |
|---|---|---|---|
| Must | Fix B1: fan out global `agent_list` over listed workspaces | `apps/api/src/dashboard-router.ts`, router test | `/api/v1/agents`, `/overview`, `/activity` never call `agent_list` without `workspaceId`; test passes; prod Agents renders |
| Must | Fix B2: page size 100 for `audit_list` / trace reads | same | test asserts `limit <= 100`; prod `/api/v1/metrics` 200 |
| Must | Fix B3: filter bar hidden by default, header text hidden until the page registry sets it | `index.html`, `dashboard.js`, css | no filter bar / "Overview" flash on non-workspace routes |
| Must | New art direction: spine frame, tokens, radius, type scale, panels with ruled header band, stamp-style state pills, mono table heads | `dashboard.css` | contract tests green; screenshots 1440/768/375 × dark/light show no overflow or clipping |
| Should | Segmented status strip for the Overview decision tiles | `dashboard.css` | 4 tiles in one strip at ≥1024px, 2×2 below; no double borders |
| Should | Wider content measure (100rem) to remove dead gutters | `dashboard.css` | at 1920 content spans ≥ 85% of main column |
| Should | Update `docs/design-guidelines.md` to the new direction | docs | doc names the direction, spine tokens and the signature |

## Project DONE contract

1. `npx vitest run apps/api/test/dashboard` (UI contract, design tokens, router, pages)
   passes; `npm run test:unit`, `npm run lint`, `npm run typecheck` pass (Windows
   baseline per AGENTS.md; POSIX-only shell fixtures excepted).
2. Local preview renders Overview, Workspaces, Agents, Activity, Settings at 1440, 768 and
   375 in dark and light with no horizontal page scroll, no clipped text, no overlapping
   controls; `document.documentElement.scrollWidth <= innerWidth` at each width.
3. Rail/topbar text and focus rings keep AA contrast in both themes (checked from token
   values: ink ≥ 4.5:1, focus ≥ 3:1 on the spine).
4. Merged to `main`, CI + "Deploy production" succeed; production reports the new
   version.
5. Production, verified by screenshots in Chrome: Overview, Workspaces, Agents,
   Activity, Approvals, Audit, Projects, Secrets, Models, Skills, Integrations,
   Knowledge, Artifacts, API Access, Settings, Profile render without error banners
   caused by the dashboard, without layout defects, in dark and light.

## Rounds

| Round | Found | Fixed |
|---|---|---|
| 1 (preview) | hamburger visible on desktop; search icon dim on the mobile spine; accent focus frame on `main` after programmatic focus; pinned `.sidebar nav` rule broken by scrollbar props | `.topbar-menu` hidden above mobile; rail colours on `.topbar .icon-btn`; `focus({ focusVisible: false })`; scrollbar props moved to their own rule |
| 2 (preview, all pages × 1440/768/375) | Settings: TypeSafe section rendered without a panel frame, buttons loose in the form | `class="panel"` + `.form-row-actions` with Save as the accent action |
| 3 (production) | see below | |

Overflow check (round 2): `scrollWidth <= innerWidth` on every route at 1440, 768 and
375; the only elements past the viewport edge sit inside the intentionally scrolling
tab strips (`.cockpit-tabs`, `.activity-filters`).

Gates: dashboard suites 317/317, `test:unit` 1489/1489, `lint` and `typecheck` clean.

## Unresolved questions

- None blocking. Production has no running agents, so the agent tree is verified on the
  local preview data, and on production only as its empty state.
