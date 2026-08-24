---
title: "Issue 33 codebase scout"
status: completed
created: 2026-08-24
tags: [scout, architecture, contracts, tests]
---

# Issue 33 codebase scout

## Summary

The change crosses four existing owners: MCP assembly, runner/worker dispatch, process lifecycle, and documentation/tests. No pending plan blocks it. The current code already centralizes schemas and most direct operations, so the plan avoids a second implementation of file/search/Git tools.

## Owning files

| Area | Evidence | Planned role |
|---|---|---|
| Shared MCP registration | `apps/api/src/mcp-server.ts:14` | Replace concrete runner dependency with operation-backend interface; accept mode-specific instructions |
| HTTP adapter | `apps/api/src/runner-client.ts:22` | Preserve request schema, principal, auth, timeout, and runner behavior |
| HTTP startup | `apps/api/src/index.ts`, `apps/api/src/app.ts` | Keep default HTTP startup; branch before loading remote-only config |
| Public contracts | `packages/contracts/src/runner-api.ts`, `packages/contracts/src/tool-schemas.ts:5,239` | Reuse unchanged tool names, schemas, annotations, and envelopes |
| Remote dispatch | `apps/runner/src/workspace-service.ts:427,726` | Regression authority; do not route local roots through runner cleanup |
| Direct operations | `worker/harness-worker.mjs:7,21` | Make root startup-configurable; preserve container default |
| Process handles | `apps/runner/src/operation-manager.ts:28,127,172,272` | Behavioral reference for local handle/output/dependency semantics |
| HTTP interoperability | `test/integration/mcp-http.test.ts:40` | Must stay green unchanged |
| Remote Docker workflow | `test/e2e/coding-workflow.docker.test.ts:78` | Regression baseline for deployed mode |
| Architecture/security docs | `docs/system-architecture.md`, `docs/security-model.md`, `docs/mcp-api.md` | Add explicit local trust boundary and lifecycle semantics |
| User docs | `README.md`, `docs-site/ai-tools/*`, `docs-site/security-model.md` | Add CLI and host-specific stdio setup |

## Expected file changes

Create:

- `apps/api/src/operation-backend.ts`
- `apps/api/src/cli-options.ts`
- `apps/api/src/local/local-workspace-backend.ts`
- `apps/api/src/local/local-worker-client.ts`
- `apps/api/src/local/local-operation-manager.ts`
- `apps/api/src/local/local-environment.ts`
- `apps/api/src/local/local-path-policy.ts`
- Focused unit/integration tests under `apps/api/test/` and `test/integration/`

Modify:

- `apps/api/src/mcp-server.ts`
- `apps/api/src/index.ts`
- `apps/api/src/app.ts` only if factory construction needs a typed adapter
- `apps/api/src/runner-client.ts`
- `apps/api/package.json` and root `package.json`
- `worker/harness-worker.mjs`
- Existing HTTP/contract tests where type signatures move
- `README.md`, `docs/system-architecture.md`, `docs/security-model.md`, `docs/mcp-api.md`, `docs/development.md`
- Relevant `docs-site/ai-tools/` pages plus installation/security/reference guidance

No planned deletion.

## Contract consumers

- `createCloudHarnessServer` consumers: HTTP factory and `apps/api/test/mcp-principal-context.test.ts`.
- `RunnerClient.call` consumers: MCP server, dashboard types/routers, and runner-client tests. Preserve dashboard interfaces; introduce a narrower shared adapter instead of widening dashboard contracts.
- `TOOL_SPECS` consumers: MCP registration, docs generation, contracts tests, skill synchronization, and HTTP interoperability tests. Do not fork or filter the array per mode.
- Worker root consumers: Docker image execution and new local worker launcher. Default must remain `/workspace` so runner images do not need a flag.

## Plan dependency scan

Pending plans inspected:

- `plans/260817-0848-2-cloud-harness-next-steps/plan.md` — related runner roadmap, no blocking file-level dependency.
- `plans/260819-1652-cloud-harness-docs-site/plan.md` — documentation coordination only.
- `plans/260817-1124-ci-release-automation/plan.md` — no overlap.

Result: `blockedBy: []` and `blocks: []`.
