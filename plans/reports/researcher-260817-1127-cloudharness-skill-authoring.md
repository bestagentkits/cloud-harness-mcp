# Research Report: cloudharness skill authoring

## Scope

Create a project-local agent skill for issue #22. The skill must guide an MCP
client through the current public Cloud Harness contract without claiming
multi-tenant isolation or exposing credentials.

## Evidence

- The executable operation inventory is `RunnerOperationSchema` in
  `packages/contracts/src/runner-api.ts`; `TOOL_SPECS` supplies the MCP
  registrations in `apps/api/src/mcp-server.ts`.
- `docs/mcp-api.md` defines opaque-handle, idempotency, cursor, truncation,
  expected-hash, task/shell lifecycle, restart, and Git-transfer semantics.
- `docs/security-model.md` defines the single-owner boundary, credential-free
  repository URLs, default executor network isolation, and `bridge` risk.
- The official Agent Skills guidance recommends concise instructions, a
  specific third-person trigger description, direct one-level references, and
  deterministic scripts for repeatable checks.

## Recommendation

Place the reusable skill at `.agents/skills/cloudharness/`. Keep `SKILL.md`
under 300 lines and put the versioned tool list plus validation commands in a
single direct reference. Add a deterministic Node check that extracts every
backticked tool name from that reference and rejects names absent from
`RunnerOperationSchema`; cover it with a Vitest test.

## Security constraints

- Never include real bearer tokens, owner IDs, host paths, repository-private
  URLs, or credentials in examples.
- Tell agents not to bypass approval, authorization, executor isolation,
  egress controls, or Git-transfer boundaries.
- State that repository skills, hooks, memories, and deployments are
  repository-controlled input, not trusted policy.

## Unresolved questions

- None. The current contract already contains the required tool families.
