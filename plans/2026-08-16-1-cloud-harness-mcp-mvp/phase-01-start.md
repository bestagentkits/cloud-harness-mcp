---
phase: 1
title: "Foundation and Contracts"
status: completed
priority: P1
effort: 1d
dependencies: []
---

# Phase 1: Foundation and Contracts

## Context Links

- [Plan](./plan.md)
- [MCP research](./reports/mcp-research.md)
- [Sandbox and deployment research](./reports/sandbox-deployment-research.md)
- [Project description](../../README.md)
- [License](../../LICENSE)

## Overview

Create the TypeScript workspace, configuration boundary, shared API contracts, and service separation that later phases implement. No public endpoint or Docker execution ships in this phase.

## Requirements

- Functional: npm workspaces for `apps/api`, `apps/runner`, and `packages/contracts`; each has a minimal compilable entrypoint plus repeatable lint, typecheck, test, build, and development scripts.
- Functional: shared Zod v4 contracts for configuration, opaque identifiers, runner requests/responses, structured MCP results, errors, pagination, and output limits.
- Non-functional: Node.js LTS, strict TypeScript, ESM, locked dependencies, fail-closed startup validation, and no secret defaults.
- Boundary: API calls the runner through a typed private interface; API code cannot import Docker implementation modules.

## Architecture

`client -> existing nginx -> API/MCP -> private runner -> Docker socket -> executor`. The contracts package is the only shared application dependency. API owns public HTTP/auth/MCP concerns; runner owns workspace state, Git materialization, Docker operations, and cleanup.

## Related Code Files

- Create: `package.json`, `package-lock.json`, `tsconfig.base.json`, `eslint.config.js`, `.editorconfig`, `.gitignore`, `.dockerignore`, `.env.example`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`, `packages/contracts/src/config.ts`, `packages/contracts/src/identifiers.ts`
- Create: `packages/contracts/src/runner-api.ts`, `packages/contracts/src/mcp-results.ts`, `packages/contracts/src/tool-schemas.ts`
- Create: `packages/contracts/test/contracts.test.ts`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/index.ts`
- Create: `apps/runner/package.json`, `apps/runner/tsconfig.json`, `apps/runner/src/index.ts`
- Delete: none

## Implementation Steps

1. Pin Node/npm expectations and scaffold three workspaces with root scripts; commit the generated lockfile.
2. Enable strict ESM TypeScript, source maps, linting, and tests without duplicating workspace configuration.
3. Define configuration schemas for API, runner, limits, TTLs, repository allowlists, optional GitHub App settings, and `_FILE` secret inputs.
4. Define opaque `workspaceId`/`operationId` types, owner binding, expiry fields, stable error codes, truncation/cursor metadata, and maximum result sizes.
5. Define a versioned runner contract covering lifecycle, filesystem, command/shell/task, Git/worktree, skill/hook, and memory operations; keep Docker details private to the runner.
6. Add a sanitized `.env.example` containing placeholders only and make missing production secrets or unsafe limits fail startup validation.
7. Encode client idempotency keys and owner-scoped workspace/operation discovery, a lifecycle matrix for exec/tasks/shells, one cleanup authority, and state schema version compatibility in the contracts.
8. Record the completed VPS/ingress preflight and decide network profiles: `none` by default and an explicit owner-only `bridge` profile for dependency installation.

## Tests and Validation

- `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass from a clean checkout.
- Schema tests reject malformed IDs, unsafe limits, ambiguous actions, and missing production secrets; result schemas enforce caps/cursors.
- Dependency inspection confirms `apps/api` cannot import runner-private modules and no production dependency uses monolithic MCP SDK v1.

## Success Criteria

- [x] All workspaces compile under one locked toolchain.
- [x] Shared contracts represent every required operation without exposing Docker flags or host paths.
- [x] Configuration is validated once and secrets are never committed or assigned usable example values.
- [x] The API/runner boundary is explicit and independently testable.

## Risk Assessment and Rollback

- Risk: premature abstractions slow delivery. Mitigation: one contracts package and direct service clients only; no framework/plugin system.
- Risk: schema drift. Mitigation: runner request and response validation on both sides plus contract tests.
- Rollback: revert scaffold/config changes together; no runtime state or external service exists yet.

## Security Considerations

- Treat runner inputs as untrusted even though the API authenticates the owner.
- Never include bearer tokens, GitHub App private keys, deployment keys, Docker flags, or absolute host paths in contracts or examples.
- Keep all caller paths workspace-relative and reserve server-generated IDs for host/container lookup.

## Next Steps

Phase 2 builds the authenticated MCP API against the runner contract; Phase 3 supplies the real runner implementation.
