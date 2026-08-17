---
phase: 3
title: "Add Client Connection Guide"
status: completed
priority: P1
effort: "2h"
dependencies: [1, 2]
---

# Phase 3: Add Client Connection Guide

## Overview

Add a practical client guide that is useful to an owner without treating every
client as a direct bearer-token integration. The README remains the canonical
source for complete command/config examples.

## Requirements

- Functional: cover ChatGPT, Codex, Claude Desktop app, Claude Code, Gemini
  CLI, Cursor, Google Antigravity, and Grok in a scannable accessible guide.
- Non-functional: use environment-variable placeholders or links to README;
  never include an actual secret, token-bearing project config, or misleading
  unsupported auth claim.

## Architecture

Use an overview grouping (direct local-header clients vs OAuth-gateway/cloud
connector constraints), followed by native `<details>` disclosures for concise
per-client setup and verification guidance. Each disclosure can link to the
appropriate README anchor and vendor documentation. This gives keyboard and
touch users an accessible, no-JavaScript control.

## Related Code Files

- Modify: `site/index.html`
- Modify: `site/styles.css`
- Read-only authority: `README.md` connection details and linked vendor docs

## Implementation Steps

1. Add a Connection guide landmark/anchor and update primary navigation/CTAs
   so users can reach it directly.
2. Add one labelled guide item per requested client with: supported path,
   safe setup summary, verification action, and canonical source link.
3. State auth limitations accurately:
   - ChatGPT custom apps and Claude Desktop hosted connectors require an
     OAuth-capable gateway for this static-bearer service.
   - Codex, Claude Code, Gemini CLI, Cursor, and Antigravity use local/private
     configuration with an environment variable or local bearer header.
   - Grok web has no documented direct static-bearer route; the xAI Responses
     API can specify the authorization header and should allowlist tools.
4. Style guide cards/disclosures as an extension of the existing console
   system with readable code treatment, focus-visible summary controls, and
   compact mobile stacking.
5. Link detail-heavy examples back to the README instead of copying all
   commands, reducing drift and secret exposure.

## Todo

- [x] All eight requested clients are visible in page text and have a useful
  safe connection outcome.
- [x] Every path either uses owner-local credentials or names the OAuth gateway
  prerequisite; no card implies that a static bearer belongs in cloud UI/chat.
- [x] Disclosure controls work with keyboard and keep the selected content
  readable at narrow widths.

## Risk Assessment

Vendor UI and auth support can change. Signal: a README source or vendor link
contradicts a card. Response: update the README authority first (if product
support changed) and have the landing guide link to the updated canonical
section; do not guess from a client brand name.
