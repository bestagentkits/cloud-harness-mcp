# Phase 4: MCP spend summary tool

**Depends on:** phase 3 merged, and #358 phase 5 merged. Phase 5 of #358 adds the
internal spend operations and `GET /api/v1/model-spend`. **Runs in parallel with:**
nothing. This phase edits the same contracts, runner dispatch, and skill files as phase 3.

**Owner files:**
- `packages/contracts/src/runner-api.ts`: add `model_spend_summary` to
  `RunnerOperationSchema`.
- `packages/contracts/src/tool-schemas.ts`: the spec, and the output schema reused from
  #358.
- `packages/contracts/src/model-tool-schemas.ts`: append to `MODEL_TOOL_OPERATIONS`.
- `apps/runner/src/model-tool-operations.ts` and `apps/runner/src/dashboard-control-service.ts`:
  one read-only dispatch case.
- `apps/api/src/local/local-workspace-backend.ts`: no change if phase 3's refusal keys on
  `MODEL_TOOL_OPERATIONS`; verify this.
- `scripts/build-docs-reference.mjs`: add the name to phase 3's "Models and spend"
  category.
- Docs:
  - `docs/mcp-api.md`, in the "Model setup and spend" section;
  - `docs-site/reference/model-providers.md`, adding one MCP example.
- Skill:
  - `.agents/skills/cloudharness/references/models-and-spend.md`, with one marker and
    one example;
  - `.agents/skills/cloudharness/references/tool-reference.md`;
  - the plugin mirror, through `npm run plugin:sync`.
- Tests:
  - `packages/contracts/test/` (the tool-spec and skill-contract suites pick up the
    name automatically);
  - `apps/runner/test/model-tool-operations.test.ts`;
  - `test/integration/` (the MCP round trip added in phase 3).

## Current state

On base `74cd394` there is no spend code yet: no `model-spend*` file exists under
`packages/contracts/src` or `apps/runner/src`, and no `model_spend` symbol appears in
contracts, runner, or API sources (grep, 2026-10-17). Every #358 symbol below is
therefore **[UNVERIFIED until #358 phase 5 merges]**, and the implementer re-greps it
first:
- `ModelSpendSummarySchema`, and the policy list schema, in
  `packages/contracts/src/model-spend-schemas.ts`;
- the internal operations `model_spend_summary` and `model_spend_policy_list` in
  `internal-runner-api.ts`;
- `GET /api/v1/model-spend` in `dashboard-control-router.ts`;
- the matching `DashboardControlService` cases.

If #358 named them differently, use #358's names and update this file's table. Do not
add an alias.

## Requirements

### Tool

| Tool | Input | Output | Annotations |
| --- | --- | --- | --- |
| `model_spend_summary` | `{}`, strict | `{ summary: ModelSpendSummary, policies: ModelSpendPolicy[] }`, strict, reusing #358's schemas without redefining them | `readOnlyHint: true`, `idempotentHint: true`, `destructiveHint: false`, `openWorldHint: false` |

- The output mirrors the body of `GET /api/v1/model-spend`, so MCP and the API return
  one shape. If #358 already wraps both parts in a single schema, reuse it directly.
- The summary is scoped to the calling principal, exactly as the Dashboard handler
  scopes it. No input selects another principal, profile, or agent.
- Every money field keeps #358's `isEstimate` and `estimated*` naming. The description
  says the figures are gateway-side estimates from pinned prices, not provider invoices.
- Draft description: "Read this principal's estimated model spend for the current
  windows, and the owner-set spend policies that bound it. Read-only. Figures are
  estimates from pinned profile prices. Spend policies are changed only on the
  Dashboard."

### Authorization and audit

- The same principal resolution as the other model tools. A read is not audited, which
  matches `model_profile_list` and the Dashboard GET.
- There is **no** `model_spend_policy_set` or `model_spend_policy_delete` tool. Raising
  or removing a cap is a budget increase, so it stays an owner input on the Dashboard.
  The tool contract test from phase 3 asserts that no `model_spend_policy_*` name exists
  in `RunnerOperationSchema`.
- **Check #358's policy audit.** The #358 phase 5 plan assumes that `mutation()` records
  an audit entry. It does not: `mutation()` (`apps/runner/src/dashboard-control-service.ts:1721-1724`)
  only maps a falsy result to `CONFLICT`. If #358 merged without explicit
  `recordAudit` calls for policy set and delete, this phase adds them through phase 2's
  audit helper pattern:
  - actions `model_spend_policy.set` and `model_spend_policy.deleted`;
  - `actor: 'dashboard'`;
  - the scope, the window, and the cap as numbers.

  That is a two-line change per handler plus one test. It is in scope because #359
  requires every budget change to be audited.

### Dispatch

`executeModelTool` gains one case that calls the existing internal summary and policy
list handlers and combines their results. There is no new query, and a missing ledger
returns the zero summary that #358 defines.

## Docs and skill

- `docs/mcp-api.md`: one row and one example, plus the note that spend policies are
  Dashboard-only.
- `docs-site/reference/model-providers.md`: one `model_spend_summary` example next to
  phase 3's examples.
- Skill: add a `<!-- cloudharness-tool:model_spend_summary -->` marker, and a
  `<!-- cloudharness-example:model_spend_summary` block with `{}`, in
  `references/models-and-spend.md`. Routing guidance: "Before starting a long agent run
  or creating a profile with a high per-run cap, read spend."
- Run `npm run docs:reference`, `npm run plugin:sync`, and
  `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`.

## Tests

- **Contracts:**
  - the spec parses `{}` and rejects extra keys;
  - the output schema is the #358 schema object (identity or `.shape` equality), so the
    two cannot drift.
- **Runner:**
  - principal A sees only A's spend after B records ledger rows;
  - an empty ledger returns the zero summary;
  - the result contains no credential sentinel, and joins phase 3's sentinel scan;
  - no `model_spend_policy_*` operation is reachable through `/v1/operations`, which
    returns `INVALID_INPUT` for an unknown operation.
- **Audit:** if the policy audit is added here, a Dashboard policy set and delete each
  write exactly one audit row with `actor: dashboard`.
- **Integration:** one MCP `tools/call model_spend_summary` round trip whose result
  equals `GET /api/v1/model-spend` for the same principal.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| #358's names or shape differ from this plan | M×L | Re-grep first, and reuse #358's names and schemas verbatim. This phase defines no money fields of its own. |
| An agent reads the estimate as a guarantee | M×M | The description and docs say "estimate". `isEstimate` is in the payload. Caps are enforced by the gateway and are not advisory. |
| A policy change stays unaudited | M×M | The explicit audit check above, with a test. |

## Rollback

Revert the PR. The change is read-only and adds no table. Any policy audit rows that
were added remain, and older code ignores them.
