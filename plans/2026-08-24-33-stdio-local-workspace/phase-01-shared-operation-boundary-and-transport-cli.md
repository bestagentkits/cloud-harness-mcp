---
phase: 1
title: "Shared operation boundary and transport CLI"
status: completed
priority: P1
effort: "2-3d"
dependencies: []
---

# Phase 1: Shared operation boundary and transport CLI

## Context links

- Parent plan: [plan.md](./plan.md)
- Research: [research findings](./research/research-findings.md)
- Issue: https://github.com/bestagentkits/cloud-harness-mcp/issues/33
- MCP SDK stdio guidance: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md

## Overview

Separate MCP tool registration from the remote runner transport, then add a transport-selecting command-line entry point. This phase must produce a working stdio handshake backed by a test double while leaving HTTP startup, authentication, and runner calls unchanged.

## Requirements

- Keep one registration path based on `TOOL_SPECS`; do not copy or filter tool definitions by mode.
- Replace the concrete `RunnerClient` dependency in the shared server factory with a narrow abort-aware operation backend.
- Bind the authenticated principal only in the HTTP adapter.
- Default to the existing HTTP server when `--transport` is absent.
- Require an absolute `--workspace` only for stdio; reject contradictory or unknown flags before server startup.
- Do not load remote-only secrets/configuration on the stdio path.
- Reserve stdout exclusively for MCP frames; route diagnostics and help failures to stderr.
- Close the transport/backend on SIGINT, SIGTERM, EOF, startup failure, and normal process completion.

## Architecture and contracts

Introduce an interface equivalent to:

```ts
interface OperationBackend {
  call(
    operation: OperationName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<RunnerResponse>;
  getInstructions?(): string;
  close?(): Promise<void>;
}
```

The exact types should come from existing contracts rather than new lookalikes. The runner-backed implementation captures the request principal at construction time and delegates to the existing `RunnerClient.call`. Dashboard code keeps using `RunnerClient` directly.

The CLI selects one of two composition roots:

- HTTP/default: existing config → authenticated request → runner-backed adapter → shared MCP server.
- stdio: validated CLI options → local backend factory (implemented in Phase 2) → `serveStdio` → shared MCP server.

## Related code files

Create:

- `apps/api/src/operation-backend.ts`
- `apps/api/src/cli-options.ts`
- Focused CLI/backend tests under `apps/api/test/`
- A stdio integration fixture under `test/integration/`

Modify:

- `apps/api/src/mcp-server.ts`
- `apps/api/src/runner-client.ts`
- `apps/api/src/index.ts`
- `apps/api/src/app.ts` only if typed factory construction requires it
- `apps/api/package.json`
- Root `package.json`
- Existing MCP principal-context and runner-client tests affected by the seam

## Implementation steps

1. Derive the operation name/input/result types from `packages/contracts` and define the smallest backend interface needed by MCP registration.
2. Refactor `createCloudHarnessServer` to accept that interface and optional mode instructions; keep every `TOOL_SPECS` registration and annotation unchanged.
3. Implement a runner-backed adapter that closes over the authenticated principal and preserves timeout, abort, validation, and error-envelope behavior.
4. Add a pure CLI parser for `--transport http|stdio`, `--workspace`, local Git capability flags, and repeated environment-forwarding flags. Make validation independently testable.
5. Split startup before remote config loading. Preserve the current HTTP composition root byte-for-byte where practical and invoke the local factory only for stdio.
6. Wire the SDK's stdio helper so stdout is protocol-only. Add stderr logging and one idempotent shutdown coordinator that closes transport and backend exactly once.
7. Add a package `bin` entry and repository script that can execute the built CLI. Do not add registry publication in this issue.
8. Update type-level and integration fixtures for the new constructor without weakening HTTP assertions.

## Todo

- [ ] Shared backend interface uses existing contract types.
- [ ] HTTP principal is bound outside the shared server factory.
- [ ] CLI parser validates mode-specific flags and absolute workspace paths.
- [ ] HTTP remains the no-flag default.
- [ ] stdio startup does not require runner/API secrets.
- [ ] stdout protocol hygiene and idempotent shutdown are tested.
- [ ] Repository-local binary invocation works after build.

## Tests and validation

- Unit: CLI defaults, valid stdio options, relative/missing workspace, unknown transport, incompatible flags, repeated env flags.
- Unit: all `TOOL_SPECS` names and annotations are registered through both composition roots.
- Unit: abort signals and structured backend errors propagate unchanged.
- Integration: use `StdioClientTransport` against the built binary and complete initialize/list-tools/call-tool.
- Regression: existing `mcp-http`, principal-context, runner-client, config, and package build tests remain green.
- Hygiene: capture child stdout and fail on any non-protocol diagnostic.

## Success criteria

- A test client negotiates with the stdio binary without requiring deployed credentials.
- Existing HTTP tests pass without changed public behavior.
- There is exactly one shared tool-registration implementation and one source of tool schemas.
- The stdio process shuts down cleanly on client close and OS signals.

## Risks and rollback

The largest risk is accidental HTTP behavior drift while moving dependencies. Keep the runner adapter thin and land this phase before local operations. If stdio composition proves unstable, the adapter refactor can remain while the `bin` entry and stdio branch are reverted without contract changes.
