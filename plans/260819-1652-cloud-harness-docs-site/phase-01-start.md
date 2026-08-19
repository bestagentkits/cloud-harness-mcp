---
title: "Phase 1: Scaffold VitePress workspace"
status: todo
phase: 1
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Scaffold VitePress workspace

## Overview

Stand up an isolated `docs-site/` VitePress workspace with base config (nav, sidebar,
local search, cleanUrls) and a placeholder home page, wired so it installs with the
repo but never builds inside the API/runner graph.

## Requirements

- Functional: `npm run docs:dev` serves locally; `npm run docs:build` produces static
  output under `docs-site/.vitepress/dist`.
- Non-functional: node >=24 (repo engine); no coupling into `npm run build`/`typecheck`;
  `npm run verify` stays green after install.

## Architecture

- New top-level `docs-site/` directory (sibling of `site/`, `apps/`, `packages/`).
- Add `docs-site` to root `package.json` `workspaces` so `npm ci` installs its deps,
  but do NOT touch the root `build`/`typecheck` scripts (they list explicit
  `-w @cloud-harness/*`, so docs is excluded automatically).
- VitePress config at `docs-site/.vitepress/config.ts`:
  - `title`, `description`, `lang: 'en'`, `cleanUrls: true`.
  - `themeConfig.search = { provider: 'local' }` (built-in minisearch; no Algolia).
  - `themeConfig.nav` + `themeConfig.sidebar` skeleton matching the IA in Phase 3.
  - `sitemap.hostname = 'https://docs.harness.agentkit.best'`.
  - `head`: favicon + theme-color from the marketing brand.
  - Dead internal links fail the build (VitePress default) — keep it on.
- Root `package.json` scripts (add, do not alter existing):
  - `"docs:dev": "vitepress dev docs-site"`
  - `"docs:build": "vitepress build docs-site"`
  - `"docs:preview": "vitepress preview docs-site"`

## Related Code Files

- Create: `docs-site/package.json` (VitePress dep; `zod-to-json-schema` added in Phase 4)
- Create: `docs-site/.vitepress/config.ts`
- Create: `docs-site/index.md` (home/hero placeholder)
- Create: `docs-site/.gitignore` (`.vitepress/dist`, `.vitepress/cache`)
- Modify: `package.json` (root: add `docs-site` to `workspaces`; add `docs:*` scripts)
- Modify: `eslint.config.js` (ignore `docs-site/.vitepress/dist`, `docs-site/.vitepress/cache`)

## Implementation Steps

1. `mkdir docs-site`; add `docs-site/package.json` pinning a current VitePress.
2. Add `docs-site` to root `workspaces`; run `npm install` to hydrate the lockfile.
3. Write `.vitepress/config.ts` with title/description/search/nav/sidebar skeleton and sitemap host.
4. Add `docs:dev`/`docs:build`/`docs:preview` root scripts.
5. Add eslint ignores for the VitePress build/cache dirs.
6. Add `docs-site/index.md` placeholder home.

## Success Criteria

- [x] `npm run docs:dev` serves the placeholder home locally.
- [x] `npm run docs:build` succeeds; output under `docs-site/.vitepress/dist`.
- [x] `npm run verify` still passes (lint/typecheck/test/build unaffected).
- [x] `git status` shows no committed `dist`/`cache`.

## Risk Assessment

- **Risk:** adding `docs-site` to workspaces pulls a large dep tree into `npm ci` and
  slows CI. *Signal:* CI install time jumps materially. *Response:* keep docs deps in
  `docs-site/package.json` only; if too heavy, drop it from `workspaces` and
  `npm ci` inside `docs-site` in the deploy workflow instead.
- **Risk:** root `eslint .` tries to lint VitePress internals. *Signal:* lint errors
  from `.vitepress/cache` or `dist`. *Response:* ignore those globs (already planned);
  lint the small hand-written config/theme sources only.
- **Risk:** VitePress requires a newer Node than an old CI image. *Signal:* build
  fails on node version. *Response:* CI already uses node 24.x; pin the same.
