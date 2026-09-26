# Dashboard QA + public sites AX

Mode: `--auto --loop 3`, no focus. Scope: operator dashboard (`apps/api/dashboard/`),
marketing site (`site/` → https://harness.agentkit.best), docs site (`docs-site/` →
https://docs.harness.agentkit.best). Owner additions during the run: the dashboard is
"missing MCP Servers"; review, try out and verify every feature per page, fixing bugs and
UX issues found.

## Scope and environment

- Dashboard: local preview (real routers from `apps/api/dist` plus a scratchpad fake
  runner with stateful MCP server data, not committed) in the built-in browser at
  1440×900, 768×1024, 375×812; production via Claude in Chrome after deploy. Secrets,
  API-key and Models pages are checked visually only (credential material).
- Public sites: production URLs, `check-discovery-surfaces.mjs` scan, source review.

## Baseline findings

| # | Surface | Evidence | Finding |
|---|---|---|---|
| D1 | Dashboard, Integrations | rail-foot `#context-nav`, hidden by the tablet rail rule | MCP Servers tab unreachable at tablet widths: the owner's "missing MCP Servers" |
| D2 | Dashboard, any page | `load()` catch only raised the alert | failed page load left "Loading…" under the alert, no retry |
| D3 | MCP Servers | `Promise.all([list, gateway])` | a failed gateway read hid every registered server |
| D4 | Every dialog form | `submitForm` catch → page alert | API error rendered behind the modal backdrop; status stuck on "Saving…" |
| D5 | MCP server dialog | header row hid inputs, not labels | orphan "Header value" caption; a saved secret ref not in the listed page was dropped on save |
| D6 | MCP Servers | 7 columns + 5 actions at 768 | actions scrolled out of view, id column broke per character |
| D7 | MCP Servers | gateway card first | the server list sat below the fold; name rule only shown after a failed submit |
| D8 | Breadcrumbs | `nav[aria-label=Breadcrumb]` | no separator ("MCP servers Linear") |
| M1 | Marketing | `/robots.txt`, `/sitemap.xml` | fall through to `index.html` with 200 (no `404.html`) |
| M2 | Marketing | head | no JSON-LD, no `llms.txt` |
| M3 | Marketing | `variants/*.html` | design explorations indexable, `variant-1` duplicates the home title |
| M4 | Marketing | home `<title>` | "Cyber-Engineering HUD Edition" is design jargon, not what the product is |
| S1 | Docs | `/robots.txt` | 404 |
| S2 | Docs | every page | no `og:image`, no per-page canonical / `og:url` / `og:title` / `og:description`, no Twitter card |
| S3 | Docs | head | no JSON-LD; no `rel="alternate" type="text/markdown"` to the existing `.md` twins |
| S4 | Docs | `_headers` | `.md` twins indexable duplicates of the HTML pages (no `X-Robots-Tag: noindex`) |
| S5 | Docs | nav | version menu hard-coded to `v0.12.0` (current 0.62.x) |

## Rubric (baseline → target)

| Area | Dashboard | Marketing | Docs |
|---|---|---|---|
| Trust / correctness | 2 → 3 (D2–D5) | 3 → 3 | 2 → 3 (S5) |
| Responsive | 2 → 3 (D1, D6) | 3 → 3 | 3 → 3 |
| Hierarchy / clarity | 2 → 3 (D7, D8) | 2 → 3 (M4) | 3 → 3 |
| AI discoverability | N/A (behind Access) | 1 → 3 (M1–M3) | 2 → 3 (S1–S4) |

## Proposals

| Rank | Proposal | Files | Acceptance check |
|---|---|---|---|
| Must | D1: section tabs above content | dashboard html/css/js, contract test | tab strip visible at 1440/768/375 |
| Must | D2–D5 error handling | `dashboard.js`, css | preview: gateway 404 still lists servers; 400 on create shows in the dialog |
| Must | M1: `robots.txt`, `sitemap.xml`, `404.html` | `site/` | `/robots.txt` text/plain; unknown path 404 |
| Must | S1/S2: robots + per-page social/canonical meta | `docs-site/.vitepress/config.ts`, `public/` | scan: 0 errors, og:image on sampled pages |
| Should | D6–D8 layout polish | dashboard css/render | no horizontal scroll at 768; cards at tablet |
| Should | M2/S3 JSON-LD, `llms.txt`, markdown alternates | `site/`, docs config | scan finds JSON-LD + llms |
| Should | M3 noindex variants, M4 descriptive title | `site/` | variants carry `noindex`; home title names the product |
| Should | S4/S5 `.md` noindex header, version from package.json | docs `_headers`, config | header present; nav shows current version |

Robots policy stays as the owner already set it (`index, follow`, no AI-crawler blocks):
the new `robots.txt` files formalize that policy and add the sitemap, they do not change it.

## Project DONE contract

1. `npx vitest run apps/api/test`, `npm run lint`, `npm run typecheck` pass;
   `npm run docs:build` and `npm run pages:check` pass.
2. Dashboard preview at 1440/768/375: every rail page renders without alert or
   horizontal page scroll; MCP Servers add/edit/enable/test/delete, tools filter,
   permissions save, logs render.
3. Merged to `main`; CI, Deploy production, both Pages deploys succeed.
4. Production dashboard (Chrome): Integrations tabs visible at desktop and tablet;
   every page renders without dashboard-caused errors.
5. Discovery scan exit 0 for both public origins; `/robots.txt` and `/sitemap.xml` are
   real files; sampled docs pages carry canonical, og:image and JSON-LD.

## Rounds

| Round | Found | Fixed |
|---|---|---|
| 1 (preview, dashboard) | D1–D8 | all |

## Unresolved questions

- None blocking.
