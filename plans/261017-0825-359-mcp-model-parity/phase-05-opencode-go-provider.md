# Phase 5: OpenCode Go provider

**Depends on:** phase 1 (the provider page exists) and phase 2 (it edits
`model-profile-state-repository.ts`). Start after phase 4 merges; see the reorder rule in
`plan.md`. **Runs in parallel with:** nothing.

**Verdict and evidence:** phase 1, "Feasibility record", OpenCode Go
([official docs](https://opencode.ai/docs/go)). **Re-verify the endpoints, model-list
URL, and header requirements on that page on the day the PR opens.** If they changed,
use the official values and update phase 1's record in the same PR.

**Owner files:**
- `packages/contracts/src/model-profile-schemas.ts`:
  - add `'opencode-go'` to `ModelProviderKindSchema` (`:11-18`);
  - add an optional `sessionHeader` to the credential entry of
    `GatewayControlApplySnapshotSchema` (`:226-236`). The entry is `.strict()`, so the
    field must be declared.
- `packages/contracts/src/model-provider-registry.ts`:
  - add a `sessionHeader: string | null` field to `ModelProviderDefinition` (`:20-37`),
    set to `null` for every existing provider;
  - add the new entry.
- `apps/runner/src/model-profile-state-repository.ts`: in `getExportSnapshot`
  (`:1003-1102`, credential entries built at `:1077-1095`), add
  `sessionHeader: getModelProvider(provider).sessionHeader` when it is non-null.
- `apps/model-gateway/src/control.ts`:
  - parse and validate the optional `sessionHeader` on each staged credential
    (`:97-108`);
  - copy it onto the `GatewayProfile` built at `:134-150`.
- `apps/model-gateway/src/types.ts`: add `sessionHeader?: string` to `GatewayProfile`
  (`:15`).
- `apps/model-gateway/src/config.ts`: export the existing header-name validation used by
  `parseSessionHeader` (`:316-326`), so `control.ts` reuses it instead of copying it.
- `apps/model-gateway/src/gateway.ts:233`: the precedence change below.
- `apps/api/dashboard/index.html:123-130`: add
  `<option value="opencode-go">OpenCode Go</option>` before "Custom".
- Docs:
  - `docs-site/reference/model-providers.md`: replace phase 1's interim OpenCode Go row;
  - `docs/configuration.md:509-512`: the header precedence;
  - `docs-site/reference/environment-variables.md:50`: one sentence on the same
    precedence;
  - `docs-site/dashboard/models.md`: one provider-table row next to DeepSeek (`:24`), but
    only after #358 phase 6 has merged; otherwise leave it to that PR's owner.
- Skill: `.agents/skills/cloudharness/references/models-and-spend.md`, adding the
  provider id to the list of examples. Then `npm run plugin:sync`.
- Tests:
  - `packages/contracts/test/model-provider-registry.test.ts`;
  - `packages/contracts/test/` snapshot-schema cases;
  - `apps/runner/test/model-provider-http.test.ts`;
  - `apps/runner/test/model-gateway-snapshot-pricing.test.ts`, or the existing snapshot
    test;
  - `apps/model-gateway/test/gateway-dynamic-control.test.ts`;
  - `apps/model-gateway/test/model-gateway.test.ts`;
  - `test/integration/dynamic-model-profiles.test.ts`.

## Current state (verified)

- **Provider kinds** exist only in the enum (`model-profile-schemas.ts:11-18`) and in
  the registry (`model-provider-registry.ts:40-147`).
  - A grep for `'deepseek'` in non-test `apps`, `packages`, and `scripts` sources finds
    only those two files. The Dashboard `<option>` list (`index.html:123-130`) is the
    one other hard-coded list.
  - So there is no exhaustive `switch` to update. The outbound allowlist derives from
    registry hosts (`apps/runner/src/model-provider-http.ts:112-136`).
- **Gateway session header today.** One instance-wide header,
  `MODEL_GATEWAY_SESSION_HEADER`, is validated in `config.ts:316-326,366`. When it is
  set, `gateway.ts:233` sends it with the agent id to **every** upstream
  (`upstream.ts:73-80`). The gateway already sends its own user agent
  (`upstream.ts:127-129`), which meets OpenCode's "send your own user agent" request.
- **Gateway snapshot.**
  - The gateway parses snapshots by hand and does not import contracts
    (`control.ts:91-108`).
  - It drops unknown credential fields today, so a runner that sends `sessionHeader` to
    an older gateway is harmless.
  - The runner and gateway ship in one release.

## Requirements

- **Connection check sends the session header.** The runner's connection check calls the provider directly and today sends no session header, so OpenCode Go can reject it with `400 MissingSessionID`. The check must send the provider's `sessionHeader` with a per-check value, and `docs-site/reference/model-providers.md` must drop that limitation.

### Registry entry

```ts
{
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  description: 'Open coding models on an OpenCode Go subscription, through its OpenAI-compatible API.',
  docsUrl: 'https://opencode.ai/docs/go',
  apiKeyUrl: 'https://opencode.ai/auth',            // confirm the Console key page at PR time
  authModes: ['bearer'],
  defaultAuthMode: 'bearer',
  endpoints: {
    'chat-completions': 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    responses: 'https://opencode.ai/inference/go/openai/v1/responses'
  },
  modelsEndpoint: { url: 'https://opencode.ai/inference/go/v1/models', auth: 'bearer' },
  catalogStrategy: 'provider-models',
  openRouterVendor: null,                            // no OpenRouter price fallback
  requiresCustomUpstream: false,
  // The subscription meters cache writes against the plan allowance; assume a premium.
  billsCacheWrites: true,
  sessionHeader: 'x-opencode-session'
}
```

The `apiKeyUrl` value is `[UNVERIFIED]`. Phase 1 found only "OpenCode Console". Use the
exact key-page URL from the docs, or `null` if the docs give none.

### Session-header precedence (gateway)

`sessionHeader = profile.sessionHeader ?? config.sessionHeader`. The provider's own
header wins. The instance-wide variable remains the fallback, for example for a Custom
OpenCode route. Both pass the same name validation, so a snapshot cannot set
`authorization`, `x-api-key`, `host`, or another header the gateway sets itself. A
snapshot whose header fails validation is rejected as a whole, which is the existing
staged-snapshot behaviour at `control.ts:95-96`.

### Limitations, documented on the provider page

- Only the OpenAI chat-completions and responses paths are used. Models that OpenCode
  serves only on its Anthropic Messages or Google paths fail the connection check with
  `unsupported_protocol`.
- No per-token prices are published.
  - Catalog entries carry `null` prices. Profiles need operator override prices, and
    the profile shows `isOverride`.
  - Every spend figure is an estimate.
  - Over MCP, an override price on a new route is the `price_unverified_for_new_route`
    escalation (phase 2). So MCP-created OpenCode Go profiles always need Dashboard
    activation, and MCP updates that change their model or credential need the
    Dashboard. This is intended.
- OpenCode enforces the plan allowances (5-hour, weekly, monthly), and the harness does
  not mirror them. A plan-limit failure appears as an upstream error.

## Tests

- **Registry:**
  - the entry passes the existing registry invariants (HTTPS, hosts, auth modes);
  - `sessionHeader` is `null` for every other provider.
- **Provider HTTP:**
  - `opencode.ai` is allowed for an `opencode-go` credential;
  - a different host is refused.
- **Snapshot:**
  - an `opencode-go` credential exports `sessionHeader: 'x-opencode-session'`;
  - other providers omit it;
  - the snapshot still parses against `GatewayControlApplySnapshotSchema`.
- **Gateway control:**
  - a snapshot with a valid `sessionHeader` is applied;
  - a snapshot with `sessionHeader: 'authorization'` is rejected, and the previous
    registry is unchanged.
- **Gateway request:**
  - the upstream receives `x-opencode-session: <agentId>` for the OpenCode Go profile,
    with no environment variable set;
  - a provider with no header sends none;
  - with `MODEL_GATEWAY_SESSION_HEADER=x-custom`, an OpenCode Go profile sends
    `x-opencode-session` and an OpenAI profile sends `x-custom`. This pins the
    unchanged fallback.
- **Integration** (`dynamic-model-profiles.test.ts`): create an `opencode-go` credential
  and profile against the test upstream, sync, make one request, and assert the header.
- **No live call.** There is no OpenCode key in CI. Production verification is
  owner-run and is not claimed by this PR.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| The OpenCode endpoints move again (third-party guides still show `/zen/go/`) | M×M | Re-verify at PR time. The registry is the single place to change, and a stale host fails closed through the allowlist. |
| An older runner cannot read an `opencode-go` row after a rollback | M×H | The rollback step below. A `safeParse` failure surfaces as an error, not as silent data loss. |
| A snapshot header becomes a header-injection channel | L×H | Reuse the gateway's existing name validation. The value is always the agent id, never snapshot data. |
| Changed behaviour for an operator who set `MODEL_GATEWAY_SESSION_HEADER` | L×L | Their header still goes to every provider except OpenCode Go, which gets its required header. Documented. |

## Rollback

1. On the Dashboard, the operator deletes OpenCode Go profiles, then OpenCode Go
   credentials.
2. Revert the PR.

No migration runs, and the snapshot field is optional in both directions.
