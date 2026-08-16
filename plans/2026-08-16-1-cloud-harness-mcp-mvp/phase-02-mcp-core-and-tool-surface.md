---
phase: 2
title: "MCP Core and Tool Surface"
status: completed
priority: P1
effort: 3d
dependencies: [1]
---

# Phase 2: MCP Core and Tool Surface

## Context Links

- [Plan](./plan.md)
- [Phase 1 contracts](./phase-01-start.md)
- [MCP protocol and SDK research](./reports/mcp-research.md)

## Overview

Implement the public Docker-free API service: authenticated Streamable HTTP MCP, modern stateless protocol behavior, SDK-managed 2025 compatibility, and the complete bounded coding tool surface backed by the typed runner client.

## Requirements

- Functional: `POST /mcp` uses TypeScript SDK v2 `createMcpHandler`; modern `2026-07-28` requests require no initialize/session, while advertised 2025 clients use SDK stateless compatibility.
- Functional: single-owner bearer authentication, `Host` allowlist, validation of every present `Origin`, body/rate/concurrency limits, health/readiness endpoints, and graceful shutdown.
- Functional: workspace lifecycle plus files, grep, exec, shell, tasks, Git, worktrees, skills, hooks, and memories tools.
- Non-functional: fresh `McpServer` per request; request factory remains cheap; reusable clients/config live outside it; no API Docker socket or job-directory mount.

## Architecture

Express composes request security and bearer middleware before adapting the SDK web handler. Thin tool handlers validate schemas and owner-bound handles, call `RunnerClient`, then map results into concise `content` plus exact `structuredContent`. Expected operational failures use `isError: true`; malformed protocol input remains a JSON-RPC error.

Tool groups and minimum operations:

- Workspace: `workspace_open`, `workspace_list`, `workspace_status`, `workspace_close`.
- Files/search: `files_list`, `files_read`, `files_write`, `files_apply_patch`, `grep_search`.
- Processes: `exec_run`; `shell_open`, `shell_io`, `shell_close`; `tasks_list`, `tasks_run`, `tasks_status`, `tasks_cancel`. Creation/launch tools accept an idempotency key so their handles are recoverable after a lost response.
- Repository: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_checkout`, `git_commit`; `worktrees_list`, `worktrees_create`, `worktrees_remove`.
- Agent context: `skills_list`, `skills_read`; `hooks_list`, `hooks_run`; `memories_list`, `memories_read`, `memories_write`.

## Related Code Files

- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/config.ts`
- Create: `apps/api/src/auth/bearer-auth.ts`, `apps/api/src/http/request-security.ts`, `apps/api/src/http/health.ts`
- Create: `apps/api/src/mcp/create-mcp-handler.ts`, `apps/api/src/mcp/register-tools.ts`, `apps/api/src/mcp/result-mapper.ts`
- Create: `apps/api/src/mcp/tools/workspaces.ts`, `apps/api/src/mcp/tools/files.ts`, `apps/api/src/mcp/tools/grep.ts`, `apps/api/src/mcp/tools/exec.ts`, `apps/api/src/mcp/tools/shell.ts`, `apps/api/src/mcp/tools/tasks.ts`
- Create: `apps/api/src/mcp/tools/git.ts`, `apps/api/src/mcp/tools/worktrees.ts`, `apps/api/src/mcp/tools/skills.ts`, `apps/api/src/mcp/tools/hooks.ts`, `apps/api/src/mcp/tools/memories.ts`
- Create: `apps/api/src/runner/runner-client.ts`, `apps/api/test/http-security.test.ts`, `apps/api/test/mcp-protocol.test.ts`, `apps/api/test/tool-results.test.ts`
- Modify: `packages/contracts/src/tool-schemas.ts`, `packages/contracts/src/runner-api.ts`
- Delete: none

## Implementation Steps

1. Install one locked SDK v2 package set: server, Express/Node adapters, client test dependency, Zod v4, and Express; prohibit production imports from `@modelcontextprotocol/sdk`.
2. Build `/mcp` with a fresh server per request, modern request metadata checks, SDK 2025 era dispatch, JSON/SSE response support, disconnect cancellation, and awaited shutdown.
3. Add constant-time pre-shared bearer verification mapped to one configured owner principal; emit a standards-shaped 401 challenge without implementing an authorization server.
4. Enforce allowed Host and present-Origin checks before MCP dispatch, then content type/body, per-principal rate, stream, request deadline, and concurrent-operation limits.
5. Implement typed `RunnerClient` with private-service authentication, deadlines, cancellation propagation, schema validation, and no Docker-specific escape hatch.
6. Register all listed tools with precise descriptions, Zod input/output schemas, least-privilege preconditions, and truthful read-only/destructive/idempotent/open-world annotations.
7. Normalize results through one bounded mapper: short text, schema-valid structured fields, stable errors, output cursor, truncation marker, and redaction before model-visible content or logs.
8. Scope skills/hooks/memories to documented workspace-relative locations; execute hooks only through runner sandbox operations, never in the API process.
9. Apply one owner/path/operation policy to equivalent mutations across structured tools, `exec_run`, shells, tasks, and hooks; document that tool annotations aid clients but do not create a security boundary.
10. Implement explicit lifecycles: request disconnect cancels synchronous exec; detached tasks/shells survive HTTP disconnect but are killed on explicit cancel/close/TTL; all resources remain discoverable by owner-bound list/status calls.

## Tests and Validation

- In-process and real SDK client tests cover `tools/list` and every tool's success/error schema and annotations.
- Raw HTTP tests cover modern direct calls, matching metadata headers/body, unsupported versions, 2025 initialize/call, JSON and request-scoped SSE, disconnect cancellation, and no `Mcp-Session-Id` on modern calls.
- Security tests prove missing/bad bearer is 401, invalid Host/Origin is 403 before dispatch, absent Origin is handled per configured non-browser policy, oversized/rate-limited traffic is bounded, and secrets are redacted.
- Parallel clients and alternating API instances cannot cross responses, handles, or progress; continuity depends only on explicit workspace/operation IDs.
- Lost-response tests replay the same idempotency key and recover the original workspace/task/shell rather than creating a duplicate.

## Success Criteria

- [x] Modern and 2025 Streamable HTTP clients list and invoke the same implementations.
- [x] All required tool domains are complete, discoverable, schema-valid, and bounded.
- [x] Every destructive tool is marked and enforced as destructive; annotations are not used as authorization.
- [x] API runtime and image contain no Docker client implementation, socket mount, or host workspace access.
- [x] Cancellation and shutdown stop or transfer ownership of active operations without orphaning API work.

## Risk Assessment and Rollback

- Risk: SDK v2 API changes. Mitigation: pin the package set, use only official handler/adapters, and verify every advertised protocol version.
- Risk: broad tools become command-policy bypasses. Mitigation: explicit schemas/actions and runner-side revalidation; no raw Docker/image/mount arguments.
- Rollback: disable the public route and revert API image while runner data remains untouched; retain compatibility tests before re-enable.

## Security Considerations

- Bearer auth is a private single-owner control, not a general OAuth system; rotate via secret file without image rebuild.
- Bind every handle to the authenticated owner and expiry on each call; high-entropy IDs must not reveal host paths.
- Never log Authorization, runner credentials, stdin, raw environment, or unredacted output. Limit request and response size before buffering.

## Next Steps

Phase 3 implements and adversarially verifies the runner and executor boundary used by these handlers.
