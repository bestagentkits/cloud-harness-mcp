---
title: Fix empty MCP tool response payloads
date: 2026-08-27
summary: Render complete human-readable tool data in CallToolResult.content while preserving structuredContent and pagination markers
---

# Fix empty MCP tool response payloads

Render complete human-readable tool data in CallToolResult.content while preserving structuredContent and pagination markers

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

## Problem & Root Cause

When calling MCP tools (e.g. `files_read`, `files_list`, `exec_run`, `grep_search`, `git_log`, `workspace_open`), standard MCP clients received only a one-line summary message (e.g., `Read 17803 bytes`, `Command exited with 0`) and zero actual data.

In `apps/api/src/mcp-server.ts`, `resultToMcp(result: ToolResult)` mapped only `result.message` into `content[0].text`, placing the actual payload data only in `structuredContent`. Clients consuming standard MCP text content (such as Claude Code, Cursor, Codex, ChatGPT, or legacy MCP negotiation) received empty payloads.

## Solution & Implementation

1. Created shape-driven formatter `formatToolResultText(result: ToolResult): string` in `apps/api/src/mcp-response-text.ts` (<100 LOC, modular):
   - Renders message summary header
   - Renders formatted payload data (multi-line blobs like `content` and `output`, collections like `entries`, `matches`, `symbols`, `workspaces`, exit codes, key-value metadata)
   - Handles error footers `Error [CODE]: message (retryable: <bool>)` even when errors carry payload data (e.g. `deployments_run`)
   - Handles truncation and pagination continuation markers correctly:
     - `truncated && cursor` -> `[truncated — next cursor: <cursor>]`
     - `truncated && !cursor` -> `[truncated — narrow the request]`
     - `!truncated && cursor` -> `[next cursor: <cursor>]`
   - Sanitizes embedded NUL characters to `\u0000`.
2. Updated `resultToMcp` in `apps/api/src/mcp-server.ts` to populate `content: [{ type: 'text', text: formatToolResultText(result) }]` while keeping `structuredContent` intact.
3. Added comprehensive unit tests in `apps/api/test/mcp-response-text.test.ts` covering all payload shapes, error results with data, pagination cases, and a property test across all `TOOL_SPECS`.
4. Extended `test/integration/mcp-http.test.ts` to assert that both modern and legacy MCP client connections receive the full payload in `content[0].text`.
5. Updated documentation in `docs/mcp-api.md` and `.agents/skills/cloudharness/references/workspace-lifecycle-and-results.md` and synced plugins via `npm run plugin:sync`.

## Verification

- `npm run plugin:check` passed.
- `npm run verify` passed: 48 test files, 307 tests green.
- `npm run verify:compose` passed.
