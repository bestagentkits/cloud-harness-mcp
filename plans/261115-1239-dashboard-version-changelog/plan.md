---
title: Dashboard sidebar version and release changelog
status: completed
branch: feat/dashboard-version-changelog
route: feature
ship: official (--ship)
issue: 661
---

# Dashboard sidebar version and release changelog

## Outcome

Operators see the running server version in the sidebar of both Dashboard shells and
can open a **Changelog** page from the sidebar that lists the release notes shipped
with that server build.

## Constraints

- Both shells stay in parity (legacy `apps/api/dashboard/` is the default; React
  `apps/dashboard/` is opt-in). Registry ids, labels, groups and titles must match
  (`apps/dashboard/src/app/page-registry.test.ts`).
- The changelog is release-tooling output (`CHANGELOG.md`, semantic-release). The
  browser never renders raw Markdown or HTML: the API parses it into a bounded,
  structured shape and only `https://github.com/` links survive.
- The readout stays "Server version": production runs the pre-version-bump commit,
  so the image's `CHANGELOG.md` lists releases up to the running version.
- A missing `CHANGELOG.md` (dev tree without it, older image) degrades to an empty
  state, never a 500.
- No new dependency.

## Non-goals

- No MCP tool or public contract change; this is a Dashboard BFF read only.
- No unreleased/"next" section and no GitHub API calls.

## Design

1. `apps/api/src/dashboard-changelog.ts`: parse `CHANGELOG.md` (release headings
   `#`/`##` `[x.y.z](compare) (date)`, `###` sections, `*` items with continuation
   lines) into `{ releases: [{ version, date, compareUrl, sections: [{ title, items:
   [{ scope, segments: [{ text, href? }] }] }] }], truncated }`, newest first, capped
   at 50 releases. Read once per process and cached.
2. `GET /dashboard/api/v1/changelog` in `dashboard-router.ts` returns
   `{ data: { version, available, releases }, truncated }` for an external principal.
3. `docker/api.Dockerfile` copies `CHANGELOG.md` (read-only) into the runtime image.
4. Legacy: registry page `changelog` (Admin group, nav), shell path `/changelog`,
   loader + renderer; the sidebar version foot becomes a link to the page.
5. React: registry page + route + feature page + model; `DASHBOARD_REACT_ROUTES`
   gains `/changelog`; the sidebar foot shows the server version (from `/server`)
   linking to the page.
6. Docs: `docs/design-guidelines.md` rail foot, `docs-site/dashboard/index.md`.

## Acceptance criteria

- [x] Both sidebars show a **Changelog** entry (Admin group) and the server version,
      which links to `/dashboard/changelog`; the collapsed rail keeps the entry
      reachable by icon/tooltip.
- [x] `/dashboard/changelog` lists releases newest first with version, date,
      compare link, sections and items; the running version is marked current.
- [x] Link hrefs other than `https://github.com/...` render as plain text; item text
      is escaped in the legacy renderer.
- [x] Missing `CHANGELOG.md` returns `available: false` and an empty-state message.
- [x] Unit tests: parser (headings, sections, scope, links, continuation lines,
      malformed input, cap), endpoint auth/shape, legacy registry/nav order, React
      registry parity, route allowlist, model.
- [x] `npm run lint`, `npm run typecheck`, unit + integration suites and the dashboard
      build pass (Windows baseline per `AGENTS.md`); CI green.

## Validation / red-team notes

- Risk: XSS through changelog text. Mitigation: structured segments, escape in legacy,
  React text nodes, href allowlist; tests cover `javascript:` and `<script>`.
- Risk: image lacks the file → empty state instead of crash (tested).
- Risk: payload size — capped at 50 releases with `truncated`.
- Risk: registry parity tests and server allowlists drift — updated together.
- Rollback: revert the PR; no state or migration.
