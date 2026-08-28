---
title: API Keys Management
description: Creating, monitoring, and revoking static MCP gateway API keys.
---

# API Keys

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/dashboard/api-keys.md</code>.
</div>

Static API keys allow IDE extensions (Cursor), local CLI agents (Claude Code, Codex), and scripts to authenticate against `https://api.harness.zuey.me/mcp` without an interactive browser OAuth flow.

## Key Rules & Limits

- **Maximum Active Keys:** Up to 10 active keys per operator identity.
- **Configurable Lifetime:** 1 day to 3,650 days (approximately 10 years).
- **One-Time Secret Reveal:** Keys are shown only once upon generation.
- **Instant Revocation:** Revoking a key denies any ongoing or future MCP requests instantly.

## Generating a Key

1. Navigate to **API Keys** in the dashboard.
2. Click **Create API Key**.
3. Choose a descriptive label (e.g. `Cursor Workstation M1`) and select an expiration timeframe.
4. Copy the key value immediately (`ch_live_...`).
