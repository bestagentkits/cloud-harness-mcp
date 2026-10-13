---
title: "Phase 4: Generated reference + AI-crawler markdown"
status: todo
phase: 4
priority: P1
effort: "7h"
dependencies: [1]
---

# Phase 4: Generated reference + AI-crawler markdown

## Overview

Two AI/contract concerns: (a) generate the **Tools reference** and **Environment
variables** pages from their source of truth with a drift-failing check (AGENTS.md:
never hand-maintain inventories); (b) emit a **raw-Markdown twin at every page's `.md`
URL** so AI crawlers get clean Markdown, plus `llms.txt` / `llms-full.txt`.

## Requirements

- Functional:
  - A generator writes `reference/tools.md` and `reference/environment-variables.md`;
    `docs:check` fails if committed pages differ from freshly generated output.
  - Every built page is also served as Markdown at its `.md` URL
    (`/getting-started` → `/getting-started.md`) with `Content-Type: text/markdown`.
  - `llms.txt` + `llms-full.txt` published as a machine index for AI consumers.
- Non-functional: deterministic output (stable ordering, no timestamps); no secrets;
  runs in CI; `.md` twins are byte-clean Markdown (frontmatter stripped).

## Architecture

### Tools reference — source: `@cloud-harness/contracts` `TOOL_SPECS`

- `TOOL_SPECS` (packages/contracts/src/tool-schemas.ts) exports per tool: `name`,
  `title`, `description`, `inputSchema` (zod), and `readOnly`/`destructive`/
  `idempotent`/`openWorld`.
- Generator imports from the **built** `@cloud-harness/contracts` (prestep builds it),
  converts each `inputSchema` with `zod-to-json-schema`, and renders a param table
  (name, type, required, constraints/default) + the four capability flags as badges,
  grouped by README categories (lifecycle, files/code, commands/shells, sessions/tasks,
  git/worktrees, extensions).

### Environment variables — source: `.env.example` (+ `config.ts` for ranges)

- Parse `.env.example` into rows: variable, default/example, and the annotation from the
  contiguous `#` comment lines directly above each assignment; commented-out vars are
  optional. Cross-reference `apps/api/src/config.ts` / `apps/runner/src/config.ts` for
  ranges; link them as the parsing owner. Never emit real secret values.

### AI-crawler Markdown twins — VitePress `buildEnd` hook

- In `.vitepress/config.ts`, a `buildEnd(siteConfig)` hook walks the resolved pages and
  writes, for each route, a `<route>.md` file into the build `outDir` containing the
  page's **source Markdown with frontmatter stripped** (keep an `# H1` from the title).
  - Route→file mapping mirrors VitePress `cleanUrls` (e.g. `dashboard/api-keys.md`
    stays reachable as `/dashboard/api-keys.md`; `index.md` → `/index.md` and root `.md`).
  - This runs inside `docs:build`, so twins exist in `dist` for every deploy — no
    server/Function needed; Cloudflare Pages serves `.md` as `text/markdown` by extension.
  - Twins include the generated `reference/*.md` too (they are ordinary pages by then).
- `llms.txt` (section index + link list) and `llms-full.txt` (concatenated page
  Markdown) emitted from the same hook or the generator; placed so they land at the
  site root in `dist`.

### Wiring

- `scripts/build-docs-reference.mjs` writes the two reference pages under
  `docs-site/reference/` (committed).
- Root scripts:
  - `"docs:reference": "npm run build -w @cloud-harness/contracts && node scripts/build-docs-reference.mjs"`
  - `"docs:check": "node scripts/verify-docs-reference.mjs"` — regenerate to a temp
    buffer, diff against committed files, nonzero exit + diff on mismatch.
- The `.md` twins + `llms*.txt` are build-output artifacts (in `dist`), not committed
  sources — produced by `docs:build` via the hook.

## Related Code Files

- Create: `scripts/build-docs-reference.mjs`, `scripts/verify-docs-reference.mjs`
- Create (generated, committed): `docs-site/reference/tools.md`,
  `docs-site/reference/environment-variables.md`
- Create (build-time hook code): `docs-site/.vitepress/config.ts` `buildEnd` +
  a helper `docs-site/.vitepress/emit-markdown-twins.ts`
- Modify: `docs-site/package.json` (add `zod-to-json-schema`), root `package.json`
  (`docs:reference`, `docs:check`)
- Reference (owners): `packages/contracts/src/tool-schemas.ts`,
  `packages/contracts/src/index.ts`, `.env.example`,
  `apps/api/src/config.ts`, `apps/runner/src/config.ts`

## Implementation Steps

1. Add `zod-to-json-schema` to `docs-site` deps.
2. Write `build-docs-reference.mjs`: import `TOOL_SPECS`, render grouped tool tables + flag badges.
3. Extend it to parse `.env.example` into the env-vars page.
4. Add the `buildEnd` hook + `emit-markdown-twins.ts`: write `<route>.md` (frontmatter-stripped) for every page into `outDir`, and emit `llms.txt`/`llms-full.txt` at the root.
5. Write `verify-docs-reference.mjs` (regenerate + diff); add `docs:reference` / `docs:check` scripts.
6. Generate + commit the initial reference pages; run `docs:build` and confirm twins + `llms*.txt` in `dist`.

## Success Criteria

- [x] `npm run docs:reference` produces both reference pages deterministically; a new tool/env var updates them with no hand edits.
- [x] `npm run docs:check` fails on a deliberate stale hand-edit and passes when regenerated.
- [x] After `docs:build`, `dist` contains a `.md` twin for every route plus `llms.txt`/`llms-full.txt`; twins are clean Markdown (no VitePress frontmatter).
- [x] Generated + twin outputs contain no secrets and render/serve correctly.

## Risk Assessment

- **Risk:** generator imports TS directly and fails. *Signal:* cannot import `.ts`.
  *Response:* import from the **built** `@cloud-harness/contracts` dist (prestep builds
  contracts); never import `src/*.ts`.
- **Risk:** `zod-to-json-schema` renders custom `.refine()` constraints poorly (paths,
  refspecs use refinements). *Signal:* param tables miss bounds. *Response:* render
  type/required/min/max/enum basics + a short prose note per tool where a refinement
  matters; link `tool-schemas.ts` as owner.
- **Risk:** `buildEnd` route→file mapping diverges from `cleanUrls`, so `/foo.md` 404s
  or collides. *Signal:* smoke check (Phase 5) can't fetch a twin, or a twin overwrites
  an HTML asset. *Response:* derive twin paths from VitePress's resolved page list, not
  by guessing; write `.md` beside the route's HTML; unit-check the mapping on a few routes.
- **Risk:** Cloudflare Pages serves `.md` as `text/plain`/`application/octet-stream`
  instead of `text/markdown`. *Signal:* Phase 5 smoke sees wrong content-type.
  *Response:* add a `docs-site/public/_headers` rule setting
  `Content-Type: text/markdown; charset=utf-8` for `/*.md`.
- **Risk:** non-deterministic generator output breaks `docs:check`. *Signal:* check
  fails with no real change. *Response:* sort deterministically; no timestamps.
- **Risk:** `.env.example` comment→variable association is fragile. *Signal:* wrong env
  descriptions. *Response:* parse contiguous `#` lines directly above each assignment;
  unit-cover the parser.
