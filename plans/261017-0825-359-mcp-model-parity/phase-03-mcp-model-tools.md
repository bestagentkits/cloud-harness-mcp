# Phase 3: MCP model tools

**Depends on:**
- phase 2, for the guard, validate, audit, plan split, and `initialStatus`;
- phase 1, because this phase adds the examples section to the provider page.

**Runs in parallel with:** nothing.

**Owner files:**
- Contracts:
  - `packages/contracts/src/runner-api.ts`: names in `RunnerOperationSchema`.
  - `packages/contracts/src/tool-schemas.ts`: `schemas`, `titles`, `descriptions`, and
    the annotation sets.
  - `packages/contracts/src/mcp-results.ts`: `OWNER_APPROVAL_REQUIRED`.
  - `packages/contracts/src/model-tool-schemas.ts` (new): output schemas and the
    `MODEL_TOOL_OPERATIONS` list.
  - `packages/contracts/src/index.ts`.
- Runner:
  - `apps/runner/src/model-tool-operations.ts` (new): dispatch, idempotency, and
    output parsing.
  - `apps/runner/src/model-tool-idempotency.ts` (new): the additive table.
  - `apps/runner/src/app.ts`: route `/v1/operations` model tools to the controls.
  - `apps/runner/src/dashboard-control-service.ts`: a public
    `executeModelTool(principal, operation, input)` that reuses the private helpers.
- API: `apps/api/src/local/local-workspace-backend.ts` (the local-mode refusal).
- Scripts: `scripts/build-docs-reference.mjs` (a "Models and Spend" category).
- Generated: `docs-site/reference/tools.md`, by `npm run docs:reference`.
- Docs:
  - `docs/mcp-api.md`;
  - `docs/security-model.md`;
  - `docs-site/reference/model-providers.md` (the examples section);
  - `docs-site/dashboard/models.md` (one note: MCP-created profiles arrive disabled);
  - `docs-site/troubleshooting.md` (an `OWNER_APPROVAL_REQUIRED` entry).
- Skill:
  - `.agents/skills/cloudharness/references/models-and-spend.md` (new);
  - `references/tool-reference.md`;
  - `SKILL.md` (a routing row);
  - the mirror under `plugins/cloud-harness/skills/cloudharness/`, via `npm run plugin:sync`.
- Tests:
  - `packages/contracts/test/model-tools-contract.test.ts` (new);
  - `apps/runner/test/model-tool-operations.test.ts` (new);
  - `apps/runner/test/internal-runner-app.test.ts`;
  - `apps/api/test/local/local-workspace-backend.test.ts`;
  - `test/integration/dynamic-model-profiles.test.ts`;
  - `packages/contracts/test/cloudharness-skill-contract.test.ts` (it runs as-is).

## Current state (verified)

- MCP tools are generated from `TOOL_SPECS` (`tool-schemas.ts:1333-1342`) and registered
  in a loop with annotations (`apps/api/src/mcp-server.ts:108-127`). The same specs serve
  the unbound, workspace-bound, and API-key gateway endpoints (`mcp-server.ts:136-170`;
  `apps/api/test/mcp-gateway-endpoint.test.ts:779`).
- A call without a principal is refused before it reaches the runner (`mcp-server.ts:58-61,72-80`).
- The runner's `/v1/operations` calls `WorkspaceService.execute` (`apps/runner/src/app.ts:28-41`).
  `execute` resolves the principal and parses with `TOOL_SCHEMA_BY_NAME`
  (`workspace-service.ts:2764-2767`). `app.ts` also receives `controls`
  (`app.ts:18`; `index.ts:73,85-88`).
- The closest precedent for owner-scoped, non-workspace tools is the `packages_*` family:
  - names in the enum (`runner-api.ts:25`);
  - dispatch before any workspace lookup (`workspace-service.ts:2772-2773`);
  - `actor: 'mcp'` in its audit (`package-service.ts:558,577`);
  - the local refusal (`local-workspace-backend.ts:156-159`).
- Agent subagents can proxy only file and search operations (`runner-api.ts:270-281`).
  The model tools must never join that enum.
- Existing idempotency tables use `(owner, key, fingerprint, result_json, created_at)`
  (`state-store.ts:520-526`).

## Tool contract

Every input is strict. Output is the standard `ToolResult` envelope. `data` is parsed by
the runner against the strict schema below before it returns, as defence in depth for
"no credential material".

| Tool | Input (sketch) | `data` (sketch) | readOnly | destructive | idempotent | openWorld |
| --- | --- | --- | --- | --- | --- | --- |
| `model_provider_list` | `{}` | `{ providers: ModelProviderDefinition[], credentials: ProviderCredentialMetadata[] }`. `providers` is exactly what `listModelProviders()` returns; `credentials` is metadata only. | yes | no | yes | no |
| `model_catalog_search` | `ModelCatalogSearchInputSchema`: `{provider, credentialId?, query?, cursor?, limit=25, capability?}` | `ModelCatalogSearchResultSchema` | yes | no | yes | yes, because it may fill the cache from the provider |
| `model_connection_verify` | `ModelConnectionVerifyInputSchema`: `{profileId, checks?}` or `{credentialId, model?, apiMode?, customUpstreamUrl?, checks?}` | `ModelConnectionVerifyResultSchema` | no | no | no | yes |
| `model_profile_list` | `{}` | `{ profiles: AgentModelProfileMetadata[] }`, the reviewed list including `pricingReview` | yes | no | yes | no |
| `model_profile_validate` | `ModelProfileValidateInputSchema` from phase 2 | `ModelProfileValidateResultSchema` from phase 2 | yes | no | yes | no |
| `model_profile_create` | `AgentModelProfileInputSchema.extend({ idempotencyKey: IdempotencyKeySchema })` | `{ profile: AgentModelProfileMetadata, replayed: boolean, activation: 'dashboard_required' }`, with `profile.status` always `DISABLED` | no | no | yes, keyed | no |
| `model_profile_update` | `AgentModelProfileUpdateInputSchema.extend({ profileId, idempotencyKey })`. `expectedGeneration` is already required. | `{ profile: AgentModelProfileMetadata, replayed: boolean }` | no | yes, because it replaces the routed revision | yes, keyed | no |

`model_spend_summary` is added in phase 4. `model_catalog_refresh`, every credential
operation, activate, disable, delete, and spend-policy writes are deliberately **not**
tools.

Draft descriptions; the final text is set in the PR:
- `model_provider_list`: "List supported model providers (auth header modes, API modes,
  catalog source) and your connected provider credentials as metadata. Keys are never
  returned."
- `model_catalog_search`: "Search the cached model catalog for one provider, optionally
  through your credential's models listing. Prices are integer micro-USD per million
  tokens; null means unknown, not free."
- `model_connection_verify`: "Check a saved profile, or a draft route on a stored
  credential, with bounded probes. It spends a few tokens, is rate limited per
  principal, and is audited. Over MCP, a custom upstream URL must already be used by
  one of your profiles on that credential."
- `model_profile_list`: "List your agent model profiles with their generation, active
  revision, pinned prices, limits, and a repricing review."
- `model_profile_validate`: "Dry-run a profile create or update. It returns the
  revision a save would write, issues, a pricing review, and any change that needs
  owner approval on the Dashboard. It writes nothing."
- `model_profile_create`: "Create an agent model profile. Profiles created over MCP
  start DISABLED; the owner activates them on the Dashboard before agent_spawn can use
  them. Needs an idempotencyKey."
- `model_profile_update`: "Create a new revision of a profile, guarded by
  expectedGeneration and an idempotencyKey. Raising limits, lowering unverified prices,
  carrying unverified prices to a new route, widening proxy operations, or using an
  unbound custom upstream returns OWNER_APPROVAL_REQUIRED and changes nothing."

### API parity

| Tool | HTTP API (Dashboard session and CSRF) |
| --- | --- |
| `model_provider_list` | `GET /api/v1/model-providers` and `GET /api/v1/provider-credentials` (`dashboard-control-router.ts:126,46`) |
| `model_catalog_search` | `GET /api/v1/model-catalog` (`:127`) |
| `model_connection_verify` | `POST /api/v1/model-connection/verify` (`:136`) |
| `model_profile_list` | `GET /api/v1/agent-model-profiles` (`:57`) |
| `model_profile_validate` | `POST /api/v1/agent-model-profiles/validate` (phase 2) |
| `model_profile_create` / `model_profile_update` | `POST` / `PATCH /api/v1/agent-model-profiles[/:id]` (`:120-121`). This is the owner channel: create is `ACTIVE` and there is no escalation guard. |
| `model_spend_summary` | `GET /api/v1/model-spend` (#358 phase 5) |

## Authorization rules

1. **Principal.** Every tool needs an authenticated principal. The runner resolves it
   with `store.resolvePrincipal`, and every read and write is filtered by `principal_id`.
   A foreign id answers `NOT_FOUND`, never `FORBIDDEN`, so existence does not leak.
   Principal-bound API keys carry the principal's full authority, as already stated for
   the gateway (`docs/security-model.md:97-109`). Docs say keys can now change model
   profiles, within the guards below.
2. **No credential reads.**
   - Outputs are strict-parsed. `ProviderCredentialMetadataSchema` has no secret field
     (`model-profile-schemas.ts:66-78`).
   - No tool creates, rotates, or exports a credential.
   - Verification text is already redacted (`model-verification-schemas.ts:46-53`).
3. **No new key destinations.** `custom_upstream_unbound` is enforced for MCP create,
   update, and draft `model_connection_verify`. For a saved profile, verify uses the
   saved URL, which is already bound.
4. **No capacity or permission increase without the owner:**
   - create always writes `DISABLED`;
   - update refuses any phase 2 escalation, whatever the profile's status, with
     `OWNER_APPROVAL_REQUIRED` (`retryable: false`,
     `resumeAction: "dashboard:models"`, and the message lists the escalations);
   - activation, credential, and spend-policy changes exist only on the Dashboard.
5. **Rate limits are shared.** Verify goes through the same `DashboardControlService`
   verifier, so MCP and Dashboard draw on one per-principal budget.
6. **Subagents.** A contract test asserts that no model tool is in
   `AgentProxyOperationSchema`.
7. **Local stdio mode.** Every model tool returns `INVALID_INPUT` with "unsupported in
   local mode because model profiles live in the remote runner", following the
   `packages_` precedent.

## Audit rules

| Event | When | Details |
| --- | --- | --- |
| `model_profile.created` | An MCP create commits | phase 2 fields plus `actor: 'mcp'` and `status: 'DISABLED'` |
| `model_profile.updated` | An MCP update commits | phase 2 fields plus `actor: 'mcp'` |
| `model_profile.change_refused` | The escalation guard refuses | `actor`, `attempted`, `escalations` |
| `model_connection.verified` | Any verify | the existing fields plus `actor: 'mcp'` |

- Reads (list, search, validate) are not audited, matching `packages_list` and catalog
  search.
- An idempotent replay records nothing.
- Schema and registry refusals are not audited. They change nothing and are visible to
  the caller.

## Idempotency and concurrency

- Table `model_tool_idempotency(principal_id, operation, idempotency_key, fingerprint, result_json, created_at, PRIMARY KEY(principal_id, operation, idempotency_key))`.
  It is created with `CREATE TABLE IF NOT EXISTS`, following
  `initializeModelVerificationSchema` (`model-profile-state-repository.ts:203-217`), and
  initialized lazily by the control service. Rows expire after 24 hours and are swept
  on write.
- The fingerprint is sha256 of the canonical JSON of the validated input without
  `idempotencyKey`.
  - Same key and same fingerprint: replay the stored `data` with `replayed: true`.
  - Same key and a different fingerprint: `CONFLICT` ("idempotency key reused with
    different input").
  - Refusals are not stored.
- Ordering inside `executeModelTool`: look up the key, plan, guard, write, record the
  idempotency row, and audit. This all runs synchronously on `node:sqlite`, with **no
  `await` before the idempotency row is written**, so two concurrent identical calls
  cannot both write. Gateway sync is awaited afterwards, and only when the changed
  profile is `ACTIVE`. A sync failure leaves the saved state and reports through
  `model_config_status`, as the Dashboard does.
- `expectedGeneration` is checked by the repository plan step and answers `CONFLICT`.
  The message names `model_profile_list` as the recovery (plan open question 3).

## Runner dispatch

- `MODEL_TOOL_OPERATIONS` (contracts) lists the seven names, and phase 4 adds the
  eighth.
- In `app.ts` `/v1/operations`, after parsing:
  - if `isModelToolOperation(op)`, call
    `controls ? controls.executeModelTool(principal, op, input) : UNAVAILABLE`;
  - otherwise call `service.execute` unchanged.
- `executeModelTool` parses with `TOOL_SCHEMA_BY_NAME`, maps each name to the private
  helper the Dashboard case uses, and passes `actor: 'mcp'`. Model logic is not
  duplicated.

## Docs and skill

- `docs/mcp-api.md`, a new section "Model setup and spend":
  - the flow: `model_provider_list` → `model_catalog_search` → `model_connection_verify`
    (keep `verificationRef`) → `model_profile_validate` → `model_profile_create`
    (DISABLED) → owner activates → `agent_spawn` with `profileId`;
  - idempotency and generation;
  - `OWNER_APPROVAL_REQUIRED`;
  - escalations;
  - local mode;
  - every price and spend figure is an estimate.
- `docs/security-model.md`, a new bullet "Model setup over MCP": rules 2 to 4 above,
  and the narrowing of the `:941` custom-URL decision for MCP callers.
- `docs-site/reference/model-providers.md`, "API and MCP examples": one JSON example per
  tool, and the matching `curl` for each HTTP route, with placeholders and no real ids.
- `docs-site/dashboard/models.md`: one paragraph saying profiles created over MCP appear
  disabled and need **Activate**, linking to the provider page.
- `docs-site/troubleshooting.md`: `OWNER_APPROVAL_REQUIRED` and what to do on the
  Dashboard.
- Skill:
  - `references/models-and-spend.md`, with one `<!-- cloudharness-tool:… -->` marker per
    tool and at least one `<!-- cloudharness-example:… -->` per mutating tool, each
    valid against its schema;
  - `tool-reference.md`, a "Models and spend" section;
  - `SKILL.md`, the routing row "Choose a model, check a connection, create or edit an
    agent model profile, read spend".

  Then run `npm run plugin:sync`.
- `scripts/build-docs-reference.mjs`: add the category (`:19-60`), then run
  `npm run docs:reference` and commit the regenerated `docs-site/reference/tools.md`.

## Tests

- **Contracts** (`model-tools-contract.test.ts`):
  - each schema accepts and rejects: a missing `idempotencyKey`, an unknown key (strict),
    and `expectedGeneration` below 1;
  - the annotation table above is exact;
  - `MODEL_TOOL_OPERATIONS` is a subset of `RunnerOperationSchema` and disjoint from
    `AgentProxyOperationSchema`;
  - no output schema has a field matching `/apiKey|secret|ciphertext|token/i`;
  - `OWNER_APPROVAL_REQUIRED` parses in `ToolResultSchema`.
- **Runner** (`model-tool-operations.test.ts`):
  - create writes `DISABLED`, is excluded from the gateway snapshot, and audits with
    `actor: mcp`;
  - after a Dashboard activate, the profile is spawnable;
  - same-key replay returns `replayed: true` with no second row and no second audit;
  - same key with different input returns `CONFLICT`;
  - update with a stale generation returns `CONFLICT`;
  - each escalation returns `OWNER_APPROVAL_REQUIRED`, writes no revision, keeps the
    generation, and writes one `change_refused` audit;
  - a non-escalating update (rename, lower limits, a catalog-verified price, a price
    raise) applies and syncs the gateway only when `ACTIVE`;
  - `custom_upstream_unbound` for create, update, and draft verify; a bound URL is
    allowed;
  - principal isolation: B cannot list, validate, verify, or update A's objects and
    gets `NOT_FOUND`;
  - the verify rate limit is shared: N Dashboard calls plus one MCP call goes over the
    limit;
  - a sentinel API key never appears in any tool's serialized result or audit details;
  - two concurrent identical creates produce one profile.
- **Runner app:** `/v1/operations` routes a model tool to the controls; without controls
  it answers `UNAVAILABLE`; other operations still reach `WorkspaceService`.
- **API local:** each model tool is refused in local mode.
- **Integration** (`dynamic-model-profiles.test.ts`): an MCP-path create, then a Dashboard
  activate, then `agent_spawn` with that profile succeeds. An MCP update that raises
  `maxCostMicros` is refused, and the Dashboard update is accepted.
- **Skill contract test** and the `npm run docs:check` reference verification.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| An agent bypasses the owner gate by chaining tools | M×H | There is no activate or credential tool. The guard runs inside the runner, after planning, on the resolved revision. The escalation matrix and integration tests cover it. |
| Prompt injection sends a key to an attacker host | M×H | `custom_upstream_unbound` covers create, update, and draft verify; tests cover each path. |
| The MCP and Dashboard paths drift | M×M | One control-service instance and the same helpers. Only the actor and the MCP guards differ. |
| Tool-list growth hurts client tool selection | M×L | Eight tools in a single "Models and Spend" category with precise descriptions. |
| Name overlap with internal operations confuses reviewers | L×L | The enums and routes are separate (`skill_suggest` precedent), and typecheck enforces both. |

## Rollback

Revert the PR. MCP clients lose the tools on their next `tools/list`. The idempotency
table stays and is ignored. Profiles created over MCP stay as `DISABLED` profiles that
the owner may activate or delete.
