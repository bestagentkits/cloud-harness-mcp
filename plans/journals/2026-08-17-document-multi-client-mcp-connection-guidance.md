---
title: Document multi-client MCP connection guidance
date: 2026-08-17
summary: Recorded the README expansion from Codex-only setup to secure client-specific MCP connection guidance.
---

# Document multi-client MCP connection guidance

## What happened

- Reviewed the README connection-docs change against its linked primary client documentation: OpenAI (ChatGPT Developer mode and Codex MCP), Anthropic (Claude connectors and Claude Code MCP), Gemini CLI, Cursor, Google Antigravity, and xAI Remote MCP Tools.
- Captured the documentation ship as a historical record; the README remains the owner of current setup instructions.

## Decision

The guidance distinguishes clients that can supply a local static `Authorization` header from hosted connector flows that are OAuth-oriented. For the latter, the documented path is an OAuth-capable gateway; no owner token is placed in an app definition, prompt, or repository configuration.

## Change

The README's Codex-only connection section became a consolidated, collapsed client-connection guide for ChatGPT, Codex, Claude Desktop, Claude Code, Gemini CLI, Cursor, Google Antigravity, and Grok. It retains the public Streamable HTTP endpoint, token-handling boundary, and shared workspace lifecycle guidance.

## Validation

- Inspected `git diff origin/main -- README.md` for scope and credential placeholders.
- Passed `ak journal validate 2026-08-17-document-multi-client-mcp-connection-guidance`.

## Follow-up

AgentWiki publish skipped; this local entry is the historical source of truth.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
