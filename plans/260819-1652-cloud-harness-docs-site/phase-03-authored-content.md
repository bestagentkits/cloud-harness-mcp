---
title: "Phase 3: Authored content"
status: todo
phase: 3
priority: P1
effort: "1d"
dependencies: [1]
---

# Phase 3: Authored content

## Overview

Author the full user-facing documentation set as Markdown, derived (not copied
verbatim) from the README, `docs/*.md`, and the `cloudharness` skill references, and
wire it into the VitePress nav + sidebar.

## Requirements

- Functional: every requested section + accepted additions exists as a page, reachable
  from nav/sidebar, cross-linked, and searchable.
- Non-functional: accurate against current source; no secrets; external links valid;
  concise operator-facing voice.

## Architecture — information architecture

Organize under `docs-site/` (paths are the sidebar structure):

- **Introduction** — `index.md` (What is it?), `how-it-works.md`, `concepts.md`
  (workspace, executor, runner, principal, idempotency key, TTL glossary).
- **Get started** — `installation.md`, `getting-started.md`, `connect.md`
  (connect your MCP client), `ai-tools/` (one page each: `chatgpt`, `claude`,
  `claude-code`, `cursor`, `codex`, `gemini`, `antigravity`, `grok` — mirror the
  README connect matrix).
- **Dashboard** — `dashboard/index.md`, then `workspaces`, `projects`, `api-keys`,
  `github`, `artifacts`, `audit`, `profile`.
- **Reference** — `reference/tools.md` *(generated, Phase 4)*,
  `reference/environment-variables.md` *(generated, Phase 4)*,
  `reference/git-transfer.md` (fetch/pull/push semantics),
  `reference/sessions-and-tasks.md` (task graph), `reference/limits.md`
  (idempotency, bounds, truncation).
- **Operate** — `troubleshooting.md`, `agent-skill.md` (the `cloudharness` skill),
  `self-host.md` (deploy your own), `security-model.md`.
- **Meta** — `faq.md`, `changelog.md` (link to GitHub releases / `CHANGELOG.md`),
  `llms.md` note; plus emit `llms.txt` / `llms-full.txt` (Phase 4/5 build step).

## Related Code Files

- Create: the `.md` files above under `docs-site/`.
- Modify: `docs-site/.vitepress/config.ts` (finalize `nav` + `sidebar` to match).
- Reference (read-only content owners): `README.md`, `docs/mcp-api.md`,
  `docs/security-model.md`, `docs/configuration.md`, `docs/deployment.md`,
  `docs/troubleshooting.md`, `docs/github-app-private-repositories.md`,
  `docs/system-architecture.md`, `docs/design-guidelines.md`,
  `.agents/skills/cloudharness/SKILL.md` + `.agents/skills/cloudharness/references/*`.

## Implementation Steps

1. Draft Introduction + Get started pages from README + `mcp-api.md` + connect matrix.
2. Draft Dashboard pages from `apps/api/dashboard/` behavior + `design-guidelines.md`.
3. Draft Reference prose pages (git-transfer, sessions/tasks, limits) from `mcp-api.md`.
4. Draft Operate + Meta pages; link Security model and Self-host to depth in `docs/`.
5. Finalize `nav` + `sidebar`; add cross-links; leave stubs for the two generated pages so links resolve.
6. Verify no secret-like strings; keep example URLs to the public hostnames only.

## Success Criteria

- [x] All requested sections + additions exist and are reachable from the sidebar.
- [x] `npm run docs:build` passes (no dead internal links).
- [x] Content matches current source; no tokens/secrets/private hosts leaked.
- [x] Connect pages cover ChatGPT, Claude (Desktop + Code), Cursor, Codex, Gemini, Antigravity, Grok.

## Risk Assessment

- **Risk:** prose duplicates `docs/*.md` and drifts. *Signal:* a `docs/*.md` change
  makes the public page wrong. *Response:* keep public pages task/audience-focused and
  link to `docs/*.md` (on GitHub) for deep internal detail; do not restate invariants
  verbatim.
- **Risk:** leaking a private host/token in an example. *Signal:* secret-scan / review
  hit. *Response:* use only public hostnames (`harness.zuey.me`, `api.harness.zuey.me`,
  `docs.harness.agentkit.best`) and placeholder tokens; Phase 5 artifact check enforces.
- **Risk:** connect instructions go stale vs README. *Signal:* README connect matrix
  changes. *Response:* link each connect page back to the README section as the owner;
  keep the page to the client-specific delta.
