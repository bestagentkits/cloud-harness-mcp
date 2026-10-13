---
title: Fix MCP github_action schema ingestion and capability consistency
date: 2026-08-30
summary: Flattened top-level github_action schema to pure z.object with superRefine for standard MCP tool projection and enforced capability consistency
---

# Fix MCP github_action schema ingestion and capability consistency

## Problem
`github_action` was the only tool defined directly as a `z.discriminatedUnion('action', [...])`. When serialized to JSON Schema for MCP `tools/list`, Zod emitted a root `oneOf: [...]` without a top-level `properties` dictionary. Downstream tool ingestion and tool-calling converters expecting standard object-shaped tool schemas either filtered or omitted the tool from the callable tool surface, while workspace capabilities continued advertising `operations.issueCreate = true`.

## Solution
1. Flattened `github_action` schema into a pure `z.object({...}).superRefine(...)` in `packages/contracts/src/tool-schemas.ts`. This guarantees an object schema with top-level `properties` and `required: ['action']`, matching all other 70 tools in the repository.
2. Maintained strict action-specific validation inside `superRefine` without action-global default bleeding (since runner nullish coalescing safely handles runtime defaults).
3. Added contract tests in `packages/contracts/test/contracts.test.ts` ensuring:
   - Every advertised GitHub operation capability maps to the presence of `github_action`.
   - All 71 tools in `TOOL_SPECS` emit object schemas with non-empty root `properties`.
4. Extended integration tests (`test/integration/mcp-http.test.ts` and `test/integration/mcp-stdio.test.ts`) to verify `github_action` tool exposure, annotations, execution, and local-mode unsupported error handling.
> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
