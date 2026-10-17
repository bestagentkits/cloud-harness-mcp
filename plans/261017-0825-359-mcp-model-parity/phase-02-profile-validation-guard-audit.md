# Phase 2: Profile validation, change guard, and audit (API parity)

**Depends on:** #358 phases 4 and 5 being merged. They append to the same operation lists
and `dashboard-control-service.ts` cases. **Runs in parallel with:** phase 1.

**Owner files:**
- `packages/contracts/src/model-profile-schemas.ts`: validate input and result schemas,
  and the escalation enum.
- `packages/contracts/src/internal-runner-api.ts`: the `model_profile_validate` metadata
  operation.
- `apps/runner/src/model-profile-state-repository.ts`: split each save into a plan step
  and a write step, and add the `initialStatus` option.
- `apps/runner/src/model-profile-guard.ts` (new): the escalation classifier and the
  custom-URL binding check, both pure.
- `apps/runner/src/model-verification/{draft-verification-store.ts, model-connection-verifier.ts}`:
  a non-consuming peek, and `actor` in the audit entry.
- `apps/runner/src/dashboard-control-service.ts`: the validate case, profile audit, and
  actor plumbing.
- `apps/api/src/{dashboard-control-router.ts, dashboard-response.ts}`: the validate route,
  the operation list, and the descriptive pass-through.
- Tests:
  - `packages/contracts/test/model-profile-schemas*.test.ts`, or a new
    `model-profile-validation-schemas.test.ts`;
  - `apps/runner/test/model-profile-guard.test.ts` (new);
  - `apps/runner/test/model-profile-state-repository.test.ts`;
  - `apps/runner/test/dashboard-control-service.test.ts`;
  - `apps/runner/test/model-connection-verifier.test.ts`;
  - `apps/api/test/dashboard-response-totality.test.ts`;
  - `test/integration/dynamic-model-profiles.test.ts`, with one validate round trip.
- Docs: `docs/security-model.md`, in the model bullets near `:941`: profile audit
  events and the `actor` field.

No public MCP tool is added here, so the skill and `docs/mcp-api.md` are not changed.

## Current state (verified)

- Model operations are listed at `internal-runner-api.ts:194-198`, their schemas are at
  `:309-328`, and their metadata requests at `:615-619`. API lists are at
  `dashboard-response.ts:231-235` and `:672-674`. Routes are at
  `dashboard-control-router.ts:57,120-136`.
- Handlers are at `dashboard-control-service.ts:483-560`.
  - Create and update call `submittedPriceProvenance`, then the repository, then
    `attachDraftVerification`, then `syncGateway` (`:500-517`).
  - Nothing records an audit entry. `mutation()` (`:1721-1724`) only maps a falsy
    result to `CONFLICT`.
- The repository mixes validation and writing:
  - `createProfile` (`model-profile-state-repository.ts:651-726`) validates the
    credential, resolves the upstream URL and pricing, builds the revision, then runs
    `BEGIN IMMEDIATE`, inserting with a hard-coded `'ACTIVE'` at `:702`.
  - `updateProfile` (`:788-929`) checks generation at `:810-812` and keeps the custom
    URL at `:862-865`.
  - The database is `node:sqlite` (`:2`), so a nested rollback-only transaction is not
    possible. A dry run therefore needs the split.
- `DraftVerificationStore.take` deletes the entry (`draft-verification-store.ts:65-77`).
  Validation must not consume a reference.
- The verifier refuses `customUpstreamUrl` for non-custom providers (`model-connection-verifier.ts:330-331`)
  and records `model_connection.verified` (`:234-250`).
- The audit API is `metadata.recordAudit(principalId, action, subjectType, subjectId, generation, details)`.
  Details may hold only strings, numbers, and booleans (`apps/runner/src/metadata-store.ts:331`).

## Requirements

### 1. Plan and write split (repository)

- Extract `planCreateRevision(principalId, input, options)` and
  `planUpdateRevision(principalId, profileId, input, options)`. Each returns
  `{ revision, displayName, current: { generation, status, activeRevision } | null }`.
  They throw exactly what the current methods throw, with no write.
- `createProfile` and `updateProfile` call the plan step, then write. Their behaviour is
  otherwise unchanged; the existing tests are the regression net.
- `createProfile` accepts `options.initialStatus: 'ACTIVE' | 'DISABLED'`, defaulting to
  `'ACTIVE'`. Only phase 3 passes `'DISABLED'`.

### 2. Guard (`model-profile-guard.ts`, pure)

`profileEscalations({ current, next, provider, boundCustomUrls })` returns a sorted,
de-duplicated list of `ModelProfileEscalation`:

| Escalation | Rule |
| --- | --- |
| `limits_raised` | `next.limits` exceeds `current.limits` on any field. Equal is not raised. |
| `price_lowered` | An effective price is lower than the current effective price. This covers input, output, cache read, cache write, and every tier. Prices are resolved with `resolveEffectivePricing` (`packages/contracts/src/model-pricing.ts`) for the provider. A dropped tier counts as lowered. It is not an escalation when `next.priceProvenance` is catalog-verified: `isOverride === false` and source `provider` or `openrouter`. |
| `price_unverified_for_new_route` | The credential or model changed and `next.priceProvenance.isOverride === true`. |
| `proxy_operations_widened` | `next.maxProxyOperations` is not a subset of `current.maxProxyOperations`. |
| `custom_upstream_unbound` | The provider is `custom` and `next.upstreamUrl` is not in `boundCustomUrls`. `boundCustomUrls` holds the upstream URLs of the principal's existing revisions on the same credential. |

With `current === null` (create), only `custom_upstream_unbound` applies.

Add `listBoundCustomUpstreams(principalId, credentialId)` to the repository. It returns
the distinct `upstream_url` values of revisions whose profile belongs to the principal
and uses that credential.

### 3. The `model_profile_validate` operation (runner and API)

Input (`ModelProfileValidateInputSchema`, discriminated on `action`):

```ts
| { action: 'create' } & AgentModelProfileInput                                      // strict
| { action: 'update'; profileId: ModelProfileId } & AgentModelProfileUpdateInput      // strict, includes expectedGeneration
```

Result (`ModelProfileValidateResultSchema`, strict):

```ts
{
  valid: boolean,
  action: 'create' | 'update',
  profileId: ModelProfileId,
  issues: Array<{ code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT'; message: string }>, // max 16; registry/repository refusal text
  revision: null | {                      // the revision a save would write right now
    credentialId, provider, model, apiMode, upstreamUrl,
    pricing: AgentModelPricing, priceProvenance: AgentModelPriceProvenance,
    limits: AgentModelLimits, maxProxyOperations: AgentProxyOperation[]
  },
  pricingReview: ModelPricingReview | null,       // vs the cached catalog price; never fetches
  verificationAttachable: boolean,                // verificationRef would attach (peek, not take)
  escalations: ModelProfileEscalation[],          // computed for every caller
  ownerApprovalRequiredOverMcp: boolean,          // escalations.length > 0
  statusAfterSaveOverMcp: 'DISABLED' | 'unchanged',
  currentGeneration: number | null
}
```

- Schema violations at the boundary still return `INVALID_INPUT` as the operation
  error. A semantic refusal produces `valid: false` with an entry in `issues`.
- A stale `expectedGeneration` becomes an issue with code `CONFLICT`.
- Validation writes nothing, consumes no draft reference, makes no network call, and
  records no audit entry.
- Route: `POST /api/v1/agent-model-profiles/validate`, with the body passed through as in
  the create route at `dashboard-control-router.ts:120`. Register it before any
  `/:id` route with the same method.
- Add the operation to `DASHBOARD_RESPONSE_OPERATIONS` and to `descriptiveOperations`,
  because its text is credential-free registry text.

### 4. Audit, both channels

- Add a private `auditProfile(principalId, action, profile, actor, extra?)` to
  `DashboardControlService`. It records `model_profile.<created|updated|activated|disabled|deleted>`
  with subject type `model_profile`, the subject id, and the new generation. Details:
  - `actor`, `revisionId`, `credentialId`, and `provider`;
  - `model` and `apiMode`;
  - the three limits;
  - `priceSource` and `isOverride`;
  - `upstreamHost` (the host only, and only for `custom`).

  Prices, URLs with paths, and keys are never recorded.
- Dashboard handlers pass `actor: 'dashboard'`.
- `model_connection.verified` gains `actor`. The verifier's `verify` takes it as a
  parameter, defaulting to `'dashboard'`.
- Add `model_profile.change_refused` with details `{ actor, attempted: 'create'|'update', escalations: 'a,b' }`,
  joined as a string because of the details type. Phase 3 is the only caller.

## Tests

- **Guard:**
  - every escalation, on its boundary: equal limits, an equal price, and a price lowered
    by one micro;
  - unknown cache prices resolving to defaults;
  - a dropped tier, and a catalog-verified lower price, which is allowed;
  - a model change carrying override prices;
  - proxy-operation subset and superset;
  - a bound and an unbound custom URL, including another credential's URL, which is
    unbound.
- **Repository:**
  - the existing create and update tests pass unchanged;
  - the plan step writes no row: count profile and revision rows before and after;
  - `initialStatus: 'DISABLED'` persists, and `getExportSnapshot` excludes the profile.
- **Validate (runner):**
  - a valid create, and a valid update with a pricing review;
  - an unknown credential and a stale generation as issues;
  - a custom URL on a non-custom provider as an issue;
  - escalations reported;
  - a `verificationRef` still attaches on a later real save, proving the peek did not
    consume it;
  - principal B validating against principal A's profile gets `NOT_FOUND` as an issue.
- **Audit:**
  - each Dashboard profile mutation writes exactly one entry with `actor: dashboard`;
  - a sentinel key string never appears in any audit details;
  - a verify entry carries `actor`.
- **API:** the response totality test covers the new operation. One integration round
  trip hits `POST /api/v1/agent-model-profiles/validate`.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| The split changes save behaviour | M×H | A pure extraction, guarded by the existing repository and integration suites. Review the diff to confirm statements were moved, not rewritten. |
| Validate reports a result that disagrees with the real save | M×M | Both run the same plan function. A test runs validate and then the save with the same input, and asserts identical revision fields. |
| Audit volume | L×L | One row per mutation, the same as packages. |
| A conflict with #358 edits | H×L | Start after #358 phases 4 and 5 merge. The edits only append. |

## Rollback

Revert the PR. Audit rows already written stay, and older code ignores them. Nothing
creates a `DISABLED` profile before phase 3.
