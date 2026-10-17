---
title: "MCP/API parity for model catalog, verification, profiles, and spend (#359)"
description: "Expose provider listing, catalog search, connection checks, profile validate/create/update, and spend usage as MCP tools with owner-gated escalation, audit, idempotency, plus the provider auth matrix, feasibility record, and an OpenCode Go provider."
status: pending
priority: P2
effort: 22h
branch: claude/determined-gates-3zyr4g
tags: [mcp, model-gateway, model-profiles, budgets, docs, umbrella-353]
created: 2026-10-17
---

# MCP/API parity for model setup and spend (#359, phase 6 of #353)

Base: `origin/dev` at 74cd394, which has #354 to #357 and phases 1 to 3 of #358.
Phases 2 to 5 of this plan start only after #358 phases 4 and 5 are merged,
because they edit the same runner, contracts, and API files (see the dependency
table). Each phase is one PR to `dev`.

## Outcome

An agent connected over MCP can see which providers are supported and connected,
search the model catalog, check a connection, dry-run a profile, create and edit
profiles, and read estimated spend. It does this with the same runner logic the
Dashboard uses. Every mutation is principal-scoped, audited, idempotent, and
generation-guarded. No tool returns credential material. Nothing reachable over
MCP can raise spend capacity, widen agent permissions, or send a key to a new
host: those changes stay on the Dashboard, which is the owner-input channel
(session plus CSRF, `apps/api/src/dashboard-router.ts:114-121`).

## Key decisions (evidence in phase files)

1. **Transport.** The new tools are ordinary public tools: names in
   `RunnerOperationSchema` (`packages/contracts/src/runner-api.ts:4-27`), specs in
   `TOOL_SPECS` (`packages/contracts/src/tool-schemas.ts:680,1155-1344`). They are
   registered by the existing loop (`apps/api/src/mcp-server.ts:108-127`) and reach the
   runner on `/v1/operations` (`apps/runner/src/app.ts:28-41`). On the runner, `app.ts`
   sends them to the **same `DashboardControlService` instance** that serves the
   Dashboard (`apps/runner/src/index.ts:73`). That instance owns the shared verification
   rate limiter, the catalog cache, and gateway sync
   (`apps/runner/src/dashboard-control-service.ts:1459-1528`). The skill contract test
   enumerates `RunnerOperationSchema` (`packages/contracts/test/cloudharness-skill-contract.test.ts:35-45`),
   so this is the only path that keeps one tool registry.
2. **Names.** Where MCP and Dashboard semantics match, the tool name equals the
   internal operation name. `skill_suggest` is already in both enums. The tools are:
   - `model_provider_list` (the issue's `provider_catalog_list`);
   - `model_catalog_search`;
   - `model_connection_verify` (`provider_connection_verify`);
   - `model_profile_list` (needed to read `generation` for updates);
   - `model_profile_validate`;
   - `model_profile_create`;
   - `model_profile_update`;
   - `model_spend_summary` (`budget_usage_get`).

   The PR may still rename them; the contract test pins whatever is chosen.
3. **Owner input boundary.**
   - MCP-created profiles are saved `DISABLED`. Spawning requires `ACTIVE`
     (`apps/runner/src/agent-manager.ts:906`), and the gateway exports only `ACTIVE`
     profiles (`apps/runner/src/model-profile-state-repository.ts:1007-1009`), so the
     owner activates the profile on the Dashboard.
   - An MCP update that raises limits, lowers unverified prices, carries unverified
     prices to a new route, or widens proxy operations is refused with the new code
     `OWNER_APPROVAL_REQUIRED`. Nothing is written, and the refusal is audited.
   - A custom upstream URL that none of the principal's revisions on that credential
     already uses is refused over MCP, for create, update, and draft verify.
   - The owner's accepted decision that a Dashboard draft check may send a Custom key
     to a submitted URL (`docs/security-model.md:941`) is unchanged; it simply does
     not extend to MCP callers.
   - No credential, activation, deletion, or spend-policy tool is exposed over MCP.
4. **Audit.**
   - The runner records `model_profile.created`, `model_profile.updated`,
     `model_profile.activated`, `model_profile.disabled`, `model_profile.deleted`, and
     `model_profile.change_refused`, each with `actor: mcp|dashboard`.
   - `model_connection.verified` gains `actor`.
   - Today profile mutations are not audited at all: `mutation()` only maps a falsy
     result to `CONFLICT` (`dashboard-control-service.ts:1721-1724`).
5. **Feasibility verdicts.**
   - **ChatGPT plan sign-in: do not ship.** A documented preview contract now exists,
     but it covers open-source and locally hosted apps; remotely hosted apps need
     OpenAI's approval. It would also need a new OAuth credential kind.
   - **OpenCode Go: ship** a first-class API-key provider. It has a documented key,
     endpoints, and client requirements, and the gateway already sends its own user
     agent and a session header.

   Citations are in phase 1.

## Phases

| # | Phase | Effort | Depends on | Parallel with |
| --- | --- | --- | --- | --- |
| 1 | [Provider matrix and feasibility docs](phase-01-provider-matrix-feasibility-docs.md) | 2h | — | 2 |
| 2 | [Profile validation, change guard, and audit (API parity)](phase-02-profile-validation-guard-audit.md) | 6h | #358 phases 4 and 5 merged | 1 |
| 3 | [MCP model tools](phase-03-mcp-model-tools.md) | 8h | 1, 2 | — |
| 4 | [MCP spend summary tool](phase-04-mcp-spend-summary-tool.md) | 2h | 3, #358 phase 5 | — |
| 5 | [OpenCode Go provider](phase-05-opencode-go-provider.md) | 4h | 1, 2, and after 4 merges | — |

Phases 1 and 2 touch disjoint files. Phases 3, 4, and 5 run in sequence:
- 3 and 4 share `tool-schemas.ts`, `runner-api.ts`, the runner dispatch module, and
  the skill reference.
- 5 edits the provider page that 1 creates and 3 extends, and
  `model-profile-state-repository.ts`, which 2 edits.

Phase 5 is independent of the MCP surface. It may move ahead of 3 and 4 only if those
two have not started yet; record any such reorder in this table.

## Data flow (MCP mutation)

```
MCP client --(bearer/OAuth/API key)--> API mcp-server.ts (TOOL_SPECS input schema)
  --> RunnerClient.call  POST /v1/operations {principal, operation, input}
  --> runner app.ts: isModelToolOperation? --> DashboardControlService.executeModelTool(principal, op, input)
        resolvePrincipal --> idempotency lookup (principal, op, key, fingerprint)
        --> plan revision (same code as Dashboard save; no write)
        --> guard: custom-URL binding + escalation classifier --> refuse + audit (no write)
        --> write (DISABLED on create) --> idempotency record --> audit(actor: mcp)
        --> [await] gateway sync only when an ACTIVE profile changed
  <-- ToolResult envelope (strict output schemas; no secrets)
```

## Acceptance criteria (issue #359)

- Agents have every tool in the list above, and the HTTP API exposes the same
  operations. The parity table is in phase 3. Measured by the tool contract tests and
  one HTTP round trip per new route.
- Every mutation is authorized by principal and audited with an actor.
- A test scans every model tool output for a sentinel API key and finds none.
- Over MCP, no spend capacity increase, permission widening, or new key destination
  is possible without a Dashboard action. Covered by the escalation test matrix in
  phase 3.
- Create and update are idempotent by key. Update is guarded by `expectedGeneration`.
- The feasibility record states its verdicts with URLs. OpenCode Go ships as a
  provider; ChatGPT plan sign-in is recorded as unsupported, with the reason and the
  conditions for revisiting it.
- Docs cover:
  - the provider support and auth matrix;
  - sync and verification limitations;
  - API and MCP examples;
  - the cloudharness skill references.

  `npm run docs:reference`, `npm run plugin:sync`, and the skill contract test pass.
- `npm run verify` is green for each PR.

## Validation

Each phase runs its focused suites first, then `npm run verify`. Phases 3 to 5 also
run `npm run docs:reference`, `npm run plugin:sync`, and
`npm test packages/contracts/test/cloudharness-skill-contract.test.ts`. Phase 5 also
runs `test/integration/dynamic-model-profiles.test.ts`, because it changes the gateway
snapshot.

## Rollback

Revert each PR on its own.

- No phase bumps the schema version. The only new table, the MCP idempotency records
  from phase 3, is additive, and older code ignores it.
- MCP-created profiles stay behind as ordinary `DISABLED` profiles.
- Reverting phase 5 has one operator step: delete OpenCode Go credentials and
  profiles first, because an older runner does not know the provider.

## Open questions (defaults used in the phases)

1. Should MCP-created profiles start `DISABLED`? Default: yes. The alternative is to
   create them `ACTIVE` when an owner-set spend policy bounds the principal, but #358
   policies are optional, so they cannot be the only guard.
2. Should escalations be refused on `DISABLED` profiles too? Default: yes, with one
   rule for every status. An agent should run `model_profile_validate` before it
   creates a profile.
3. A generation conflict returns `CONFLICT`, the repository's current code, rather
   than the `STALE_GENERATION` that `packages_*` uses. Default: keep `CONFLICT` for
   parity with the Dashboard. The message tells the agent to re-read with
   `model_profile_list`.
4. Is the repository public? This only matters if the owner later asks OpenAI to
   approve ChatGPT plan usage. It was not checked, because GitHub was out of bounds.
