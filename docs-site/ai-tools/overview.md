---
title: AI Tools Integration Overview
description: Compatibility matrix and connection protocols across major AI tools and IDEs.
---

# AI Tools Integration Overview

Cloud Harness MCP is compatible with all leading AI agent environments, IDEs, and coding tools. Depending on the client's authentication capabilities, you will connect using either **Managed OAuth** or a **Static API Key**.

## Compatibility Matrix

| AI Tool / Client | Connection Mode | Target Endpoint | Configuration Surface |
|---|---|---|---|
| **ChatGPT** | Managed OAuth | `https://harness.zuey.me/mcp` | Web Settings → Apps → Create Custom MCP |
| **Claude Desktop** | Managed OAuth / Gateway | `https://api.harness.zuey.me/mcp` | `claude_desktop_config.json` |
| **Claude Code** | Static API Key | `https://api.harness.zuey.me/mcp` | `claude mcp add` / env var |
| **Cursor IDE** | Static API Key | `https://api.harness.zuey.me/mcp` | Settings → Features → MCP |
| **OpenAI Codex** | Static API Key | `https://api.harness.zuey.me/mcp` | `~/.codex/config.toml` |
| **Gemini CLI** | Static API Key | `https://api.harness.zuey.me/mcp` | Environment header / CLI flags |
| **Google Antigravity** | Static API Key | `https://api.harness.zuey.me/mcp` | Antigravity MCP Settings |
| **Grok / xAI** | Static API Key | `https://api.harness.zuey.me/mcp` | Responses API tool definitions |

To connect a static-key client to the [MCP Gateway](/mcp-gateway) instead, use the same key with `https://api.harness.zuey.me/mcp-gateway`.

---

## Native Skills Support

Clients that implement the MCP Skills extension (`io.modelcontextprotocol/skills`, protocol revision
`2026-07-28`) can discover and read your built-in and owner skills directly from the HTTP `/mcp`
endpoint. Serving a skill does not activate it: the client decides whether to load it, and any script
still runs only through `skills_run`. Other clients keep using the `skills_list`, `skills_read`, and
`skills_run` tools. See [Skills over MCP](/agent-toolkits#skills-over-mcp-native-client-skills).

---

## Security Best Practices for Clients

1. **Keep Secrets Local:** Never paste API keys into prompts, git commits, or shared project configs.
2. **Use Environment Variables:** Reference tokens via environment variable substitution (e.g. `$CLOUD_HARNESS_MCP_TOKEN`) in tool config files whenever supported.
3. **Approval Modes:** For tools modifying the filesystem or Git (`files_write`, `git_push`), configure your AI client to require interactive confirmation before execution.
