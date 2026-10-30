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
| **Claude Desktop** | Managed OAuth (recommended) or Static API Key | `https://harness.zuey.me/mcp` (OAuth) or `https://api.harness.zuey.me/mcp` (key) | Connectors UI (OAuth) or `claude_desktop_config.json` (key) |
| **Claude Code** | Static API Key | `https://api.harness.zuey.me/mcp` | `claude mcp add` / env var |
| **Cursor IDE** | Static API Key | `https://api.harness.zuey.me/mcp` | Settings → Features → MCP |
| **OpenAI Codex** | Managed OAuth (recommended) or Static API Key | `https://harness.zuey.me/mcp` (OAuth) or `https://api.harness.zuey.me/mcp` (key) | `~/.codex/config.toml` |
| **Gemini CLI** | Static API Key | `https://api.harness.zuey.me/mcp` | Environment header / CLI flags |
| **Google Antigravity** | Static API Key | `https://api.harness.zuey.me/mcp` | Antigravity MCP Settings |
| **Grok / xAI** | Static API Key | `https://api.harness.zuey.me/mcp` | Responses API tool definitions |

To connect a static-key client to the [MCP Gateway](/mcp-gateway) instead, use the same key with `https://api.harness.zuey.me/mcp-gateway`.

---

## Staying Signed In (Managed OAuth)

Managed OAuth clients sign in once in the browser and then refresh short-lived access tokens silently. They sign in again only when the OAuth grant expires. An operator sets that duration in **Dashboard → [Settings](/dashboard/settings#mcp-oauth-sessions) → MCP OAuth sessions**; **Stay signed in** uses the provider maximum. Static API key clients are unaffected: their key's own expiry applies. If a client keeps asking you to sign in, see [Troubleshooting](/troubleshooting#_6-frequent-mcp-sign-out-or-re-authentication-prompts-in-ai-tools).

---

## Native Skills Support

Clients that implement the MCP Skills extension (`io.modelcontextprotocol/skills`, protocol revision
`2026-07-28`) can discover and read your built-in and owner skills directly from the HTTP `/mcp`
endpoint. Serving a skill does not activate it: the client decides whether to load it, and any script
still runs only through `skills_run`. Other clients keep using the `skills_list`, `skills_read`, and
`skills_run` tools. See [Skills over MCP](/agent-toolkits#skills-over-mcp-native-client-skills).

---

## Model Setup from Your AI Tool

Any connected client can prepare the model profiles your subagents use, so you can ask it to
"pick a cheap model for reviews and set up a profile". The `model_*` tools list providers and
your connected keys, search the catalog, check a connection, dry-run and save profiles, and read
estimated spend. Three things stay with you on the Dashboard [Models page](/dashboard/models):

- **Keys.** Add provider keys on the Dashboard. No tool accepts or returns a key.
- **Activation.** A profile your AI tool creates arrives **Disabled**. Review it and click
  **Activate** before `agent_spawn` can use it.
- **Escalations.** Raising a limit or lowering a price, widening an agent's proxy tools, or
  pointing a Custom key at a new URL returns `OWNER_APPROVAL_REQUIRED`; make that change on the
  Dashboard. See [Troubleshooting](/troubleshooting#_31-model-profile-create-model-profile-update-or-model-connection-verify-returns-owner-approval-required).

`model_profile_update` is marked destructive, and `model_connection_verify` spends a few
provider tokens, so a client that asks before such tools will prompt for them. The full flow is
in [Model Providers](/reference/model-providers#api-and-mcp-examples).

## Continuing Subagent Work

By default each `agent_spawn` agent is one-shot: when it ends, its conversation is gone, and a
follow-up is a new agent that your AI tool briefs again. When the operator turns on session
persistence, your tool can pass `continueFrom` with an ended agent's ID, and the new agent starts
with that agent's conversation on the same model profile. An opt-in durable engine
(`runtime: "pi-durable"`) is available for long tasks that may be interrupted; leave `runtime`
out otherwise. Both are off unless the operator enables them, and a stopped agent is never
reported as successful. Field details are in the [tool reference](/reference/tools#agent-spawn),
and the errors you may see are in [Troubleshooting](/troubleshooting#_32-agent-spawn-returns-not-supported-for-continuefrom-or-runtime-pi-durable).

---

## Security Best Practices for Clients

1. **Keep Secrets Local:** Never paste API keys into prompts, git commits, or shared project configs.
2. **Use Environment Variables:** Reference tokens via environment variable substitution (e.g. `$CLOUD_HARNESS_MCP_TOKEN`) in tool config files whenever supported.
3. **Approval Modes:** For tools modifying the filesystem or Git (`files_write`, `git_push`), configure your AI client to require interactive confirmation before execution.
