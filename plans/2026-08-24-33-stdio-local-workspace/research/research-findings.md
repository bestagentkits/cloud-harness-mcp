---
title: "Issue 33 research findings"
status: completed
created: 2026-08-24
tags: [research, mcp, stdio, filesystem, process-lifecycle]
---

# Issue 33 research findings

## Summary

The feature is feasible without duplicating the public tool surface. The smallest architecture is to generalize the MCP server factory around an operation-backend interface, keep `RunnerClient` as the HTTP implementation, and add a local backend that reuses the existing worker for one canonical startup root. A separate local process manager is still required because current shell/session/task lifecycle is Docker-specific.

The major design constraint is honesty about security: file APIs and command working directories can be confined, but repository-controlled commands execute with the local user's authority and can access resources outside the workspace unless an optional isolation layer is added later.

## Repository findings

1. `apps/api/src/mcp-server.ts:14` registers every `TOOL_SPECS` entry but depends directly on concrete `RunnerClient` and an authenticated principal. This is the narrowest seam to generalize.
2. `apps/api/src/runner-client.ts:22` already presents a single `call(operation, input, principal, signal)` dispatch API. Bind the principal in an HTTP adapter instead of leaking authentication into the shared server factory.
3. `packages/contracts/src/tool-schemas.ts:5` enforces relative, traversal-free paths at schema level; `TOOL_SPECS` at line 239 owns the public annotations. Local mode should reuse these unchanged.
4. `apps/runner/src/workspace-service.ts:726` validates input, owns lifecycle, intercepts remote Git/GitHub/process operations, and sends ordinary operations to the worker through `runWorker` at line 427.
5. `worker/harness-worker.mjs:7` hard-codes `/workspace`. Its `safePath` at line 21 already performs lexical and canonical checks and most file/search/Git/repository-extension operations. Parameterizing its root from trusted startup configuration gives the largest safe reuse.
6. `apps/runner/src/operation-manager.ts:28` stores handles and output bounds, but process launch/termination uses Docker. Extracting the lifecycle/state concepts or implementing a parallel local manager is necessary for shells, named sessions, and tasks.
7. `test/integration/mcp-http.test.ts:40` proves SDK negotiation/tool registration over HTTP; `test/e2e/coding-workflow.docker.test.ts:78` is the remote regression baseline.
8. The public contract now includes `github_action` and `exec_run.privileged`, which issue #33 did not explicitly address. Local v1 must define their behavior rather than silently inheriting runner assumptions.
9. All existing npm workspaces are private. Adding a `bin` entry can prove the CLI inside the repository, but npm publication belongs to a separate release decision.

## External findings

- The MCP TypeScript SDK v2 exposes `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`. It owns transport lifetime and returns a closeable handle. Diagnostics must go to stderr because stdout is the JSON-RPC channel.
- Codex supports local stdio servers through `codex mcp add ... -- <command>` and through `[mcp_servers.<name>]` with `command`, `args`, `env`, and optional `cwd`.
- Claude Code supports `claude mcp add --transport stdio <name> -- <command> ...` and project/user JSON entries with `command`, `args`, and `env`.
- Cursor uses `.cursor/mcp.json` or its global equivalent with `command` and `args` for local stdio servers.
- Node's `realpath` canonicalizes symlinks; `lstat` inspects the link itself; `O_NOFOLLOW` can reject a final symlink on POSIX. Node also warns against check-then-open patterns, so file handlers should open directly where practical and handle errors.
- On POSIX, detached children lead their own process group/session; group signaling can terminate descendant processes. Windows differs and cannot use a negative PID process-group signal.

## Options considered

| Option | Benefits | Costs | Decision |
|---|---|---|---|
| Add local code directly to the HTTP runner | Reuses lifecycle service | Pulls Docker/auth/state assumptions into local mode; risks deleting local roots | Reject |
| Build a separate local MCP server with copied tools | Fast prototype | Contract drift, duplicated annotations and handlers | Reject |
| Shared MCP factory + local backend + parameterized existing worker | Reuses schemas and most operations; isolates lifecycle differences | Requires a local process manager and careful worker environment | Recommended |
| Mount local root into Docker | Stronger command isolation | Requires Docker, changes UX, contradicts direct host-mode v1 | Follow-up option |

## Recommended security contract

- Resolve `--workspace` to an existing directory and canonical real path before starting stdio.
- Never accept a host root in MCP tool input.
- Validate the opaque local `workspaceId` on every non-list operation.
- Preserve schema-level lexical checks, then resolve target/parent below the canonical root per operation.
- Use `lstat`/realpath and `O_NOFOLLOW` where supported; re-check containment after writes/moves/mkdir and test deterministic symlink-swap scenarios.
- Keep the worker root in trusted process configuration, never request JSON.
- Build subprocess environments from an allowlist; explicitly remove Cloud Harness control secrets and permit extra variables only through explicit CLI flags.
- Reject local privileged execution. Do not reuse dashboard approval grants.
- Enable local Git network operations only by startup flags; require a separate push flag.
- Treat hooks, skills, deployments, exec, shells, and tasks as repository-controlled host code with user permissions.
- Close with TERM → bounded grace → KILL, reconcile handles, then exit without deleting files.

## Sources

- Issue: https://github.com/bestagentkits/cloud-harness-mcp/issues/33
- MCP TypeScript SDK stdio: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md
- MCP SDK package layout: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md
- Codex MCP configuration: https://developers.openai.com/codex/mcp
- Claude Code MCP configuration: https://code.claude.com/docs/en/mcp
- Cursor MCP configuration: https://docs.cursor.com/context/model-context-protocol
- Node filesystem API: https://nodejs.org/api/fs.html
- Node child-process API: https://nodejs.org/api/child_process.html

## Open questions

None blocking for planning. The plan proposes POSIX-first support, opt-in network Git, and unsupported local `github_action`/privileged execution; maintainers should approve those choices before implementation.
