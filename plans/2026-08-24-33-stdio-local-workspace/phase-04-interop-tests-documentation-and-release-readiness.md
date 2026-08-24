---
phase: 4
title: "Interop tests, documentation, and release readiness"
status: completed
priority: P2
effort: "2d"
dependencies: [1, 2, 3]
---

# Phase 4: Interop tests, documentation, and release readiness

## Context links

- Parent plan: [plan.md](./plan.md)
- Codex MCP configuration: https://developers.openai.com/codex/mcp
- Claude MCP configuration: https://code.claude.com/docs/en/mcp
- Cursor MCP configuration: https://docs.cursor.com/context/model-context-protocol
- MCP SDK package guidance: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md

## Overview

Prove interoperability and backward compatibility, document the local trust boundary and client setup, and make the repository-local CLI ready for maintainer review. This phase does not publish an npm package.

## Requirements

- Exercise the built stdio binary through the official MCP client transport, not only direct backend calls.
- Verify current protocol negotiation and the repository's supported legacy negotiation path.
- Ensure stdout stays protocol-only under success, warning, tool error, and shutdown paths.
- Cover the full lifecycle and capability matrix with representative tools rather than duplicating every unit test at end-to-end level.
- Run the existing HTTP and remote Docker regression suites unchanged when prerequisites are available.
- Document exact commands/configuration for Claude Code/Desktop, Cursor, and Codex.
- State prominently that direct local commands run with host-user permissions and that file-path confinement is not a command sandbox.
- Document default-disabled network Git/push, environment forwarding, POSIX-v1 status, unsupported privileged/GitHub actions, and close-without-delete behavior.
- Keep CLI publication/versioning out of scope; document repository-local and installed-package invocation separately if both are supported.

## Documentation targets

Modify the smallest owning sections in:

- `README.md`
- `docs/system-architecture.md`
- `docs/security-model.md`
- `docs/mcp-api.md`
- `docs/development.md`
- Relevant installation, AI-tool, security, and reference pages under `docs-site/`

Generated tool references must continue to derive from `TOOL_SPECS`. Do not hand-maintain a second local-mode schema list; document only capability differences.

## Implementation steps

1. Build an integration harness using `StdioClientTransport` that spawns the packaged CLI in a temporary directory containing spaces.
2. Test initialize, instructions, tool listing/annotations, representative file/search/exec/process/Git calls, close, and process exit.
3. Run negotiation tests for the current protocol version and supported legacy client behavior already covered by HTTP.
4. Add assertions that stdout contains only MCP JSON-RPC frames and stderr contains human diagnostics.
5. Add shutdown suites for client EOF, workspace close, SIGINT, SIGTERM, cancellation, and startup error; verify the selected root and sentinel files survive.
6. Add remote-regression assertions: no-flag startup remains HTTP, HTTP auth/principal behavior is unchanged, and Docker worker root remains `/workspace`.
7. Document CLI usage, flag authority, lifecycle/capability matrix, threat boundary, troubleshooting, and uninstall/cleanup behavior.
8. Add tested configuration snippets for:
   - Codex `codex mcp add <name> -- <command> ...` and `[mcp_servers.<name>]`.
   - Claude `claude mcp add --transport stdio ...` and JSON configuration.
   - Cursor `.cursor/mcp.json` with `command` and `args`.
9. Run docs link/code-snippet checks and verify every external configuration claim against the linked primary documentation.
10. Run the full repository verification pipeline and record unavailable environment-gated tests honestly in the implementation PR.

## Todo

- [ ] Official stdio client exercises the built CLI end to end.
- [ ] Modern and supported legacy negotiation are covered.
- [ ] Protocol hygiene and every shutdown path are asserted.
- [ ] HTTP and Docker regressions remain green.
- [ ] User and architecture/security docs explain local authority accurately.
- [ ] Claude, Cursor, and Codex examples are verified.
- [ ] Packaging works locally; publication remains out of scope.
- [ ] Full verification results are recorded for review.

## Tests and validation

Run in increasing scope:

1. Focused API/local unit tests.
2. Stdio integration suite with temporary Git and non-Git roots.
3. Existing HTTP integration and contract suites.
4. Package typecheck, lint, build, and docs checks.
5. `npm run verify`.
6. Docker/E2E workflow when Docker and broker prerequisites are available.

Include leak checks after the suite for owned child processes and temporary roots. Fail tests if the CLI logs non-protocol bytes to stdout or deletes the selected root.

## Success criteria

- The documented Codex, Claude, and Cursor configurations start the same built stdio binary.
- All shared tool names and annotations match HTTP mode.
- Security and lifecycle documentation match tested behavior, including no-delete close and host authority.
- `npm run verify` passes; any prerequisite-gated Docker/E2E result is explicitly recorded.
- Maintainers can review implementation without a hidden release/publication step.

## Risks and rollback

Interop examples can drift as client products evolve, so link primary docs and keep one executable smoke fixture as the authority. If one client requires product-specific wrapping, document the wrapper without changing the shared MCP contract. A failed publication concern does not block this issue because repository-local packaging, not registry release, is the acceptance boundary.
