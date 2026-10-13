---
phase: 3
title: "Documentation & Zero-Reauth Guides"
status: completed
priority: P2
effort: "1h"
dependencies: [2]
---

# Phase 03: Documentation & Zero-Reauth Guides

## Overview
Update public MCP documentation, troubleshooting guides, configuration guides, deployment guides, and docs site to thoroughly explain:
1. Why `https://harness.zuey.me/mcp` (Managed OAuth) expires and how to adjust Cloudflare Zero Trust Session Duration (up to 1 month / 730 hours).
2. How to use the API Key Gateway at `https://api.harness.zuey.me/mcp` with a 10-year API key for a completely permanent, zero-reauth connection across all AI tools (Claude Code, Cursor, Codex, etc.).
3. Update key lifetime references from "1–365 days" to "1–3,650 days (up to 10 years)".

## Requirements
- Update `docs/mcp-api.md`:
  - Mention key lifetime is 1–3,650 days (up to 10 years).
  - Clarify the static client lane `https://api.harness.zuey.me/mcp` as the zero-reauth solution for AI agents and coding tools.
- Update `docs/troubleshooting.md`:
  - Add explicit troubleshooting section for "Frequent MCP session expiration or re-authentication prompts in AI tools".
  - Detail Cloudflare Zero Trust Session Duration adjustment (Zero Trust -> Access -> Applications -> Edit -> Session Duration -> 1 month).
  - Detail switching AI tools to `https://api.harness.zuey.me/mcp` with `Authorization: Bearer <key>`.
- Update `docs/configuration.md` and `docs/deployment.md`:
  - Update API key references and session duration best practices.
- Update docs-site reference files if needed (`npm run docs:reference` / sync).

## Related Code Files
- Modify: `docs/mcp-api.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/configuration.md`
- Modify: `docs/deployment.md`
- Modify: `docs-site/` (as applicable)

## Implementation Steps
1. Edit `docs/mcp-api.md` to reflect 1–3,650 day API keys.
2. Edit `docs/troubleshooting.md` with full explanations and actionable remediation steps.
3. Edit `docs/configuration.md` and `docs/deployment.md` with session duration details.
4. Run `npm run docs:build` or `npm run docs:reference` to ensure docs build succeeds.

## Success Criteria
- [x] Documentation accurately reflects 1–3,650 days (up to 10 years) key expiration.
- [x] Clear step-by-step guidance exists for both Cloudflare Access session duration tuning and API Key Gateway usage.
- [x] No broken links or markdown lint errors in docs.

## Risk Assessment
- Risk: Divergence between docs and docs-site.
  - Mitigation: Run `npm run docs:reference` and `npm run plugin:sync` to ensure complete parity.
