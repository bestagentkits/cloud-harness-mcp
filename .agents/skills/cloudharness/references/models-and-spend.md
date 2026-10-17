# Models and spend

Use these tools to choose the model a subagent runs on and to prepare its
agent model profile for `agent_spawn`. They act only on your own principal and
need no workspace. Local stdio mode refuses them with `INVALID_INPUT`.

The owner keeps three decisions on the Dashboard Models page, and no tool can
make them:

- **Keys.** Provider keys are added, rotated, and deleted only there. No tool
  accepts, returns, or reads one; never put a key in a tool argument.
- **Activation.** A profile you create arrives `DISABLED`. Tell the owner to
  review and **Activate** it; `agent_spawn` refuses it until then. No tool
  activates, disables, or deletes a profile.
- **Escalations.** A save that moves a profile to another credential, raises
  a limit, lowers a price that is not catalog-verified, carries override prices
  to another model or credential, widens proxy operations, or points a Custom
  key at a new URL returns `OWNER_APPROVAL_REQUIRED` and changes nothing,
  whatever the profile's status. Do not retry it or work around
  it: report the listed escalations and ask the owner to make the change on the
  Dashboard.

Flow: `model_provider_list` → `model_catalog_search` →
`model_connection_verify` (draft) → `model_profile_validate` →
`model_profile_create` → owner activates → `agent_spawn` with that `profileId`.
To change a profile: `model_profile_list` → `model_profile_validate` with
`action: "update"` → `model_profile_update`.

<!-- cloudharness-tool:model_provider_list -->
### `model_provider_list`

- Lists the supported providers (auth modes, API modes and endpoints, catalog
  source, whether a Custom upstream URL is required, and the session header the
  harness sends for you, if any) and your connected
  credentials as metadata: `id`, `label`, `provider`, `authMode`, `status`,
  `activeVersion`, and the last check.
  A provider's `apiKeyUrl` is the page where the owner creates a key, not a key.
- No credential for a provider means the owner has not added one; ask them to,
  rather than asking for the key.
- Optional `provider` narrows both lists. It is a registry id, for example
  `openai`, `openrouter`, `deepseek`, `opencode-go`, or `custom`.

<!-- cloudharness-example:model_provider_list
{"provider":"openrouter"}
-->

<!-- cloudharness-tool:model_catalog_search -->
### `model_catalog_search`

- Required: `provider`. Optional `credentialId` lists what your key can call,
  plus `query`, `capability`, `limit`, and `cursor`.
- Prices are integer micro-USD per million tokens and are estimates. `null`
  means unknown, never free. `availability: "public_catalog"` comes from a
  public list and does not prove your key can call the model;
  `listed_for_credential` does.
- A cold cache is filled from the provider, so the call can be slow. A
  `stale` source still answers from its last good copy.
- When saving, use an entry's `providerModelId` as `model` and its
  `pricing.provenance.sourceModelId` as `catalogPriceRef.sourceModelId`, so the
  profile pins catalog-verified prices.
- `opencode-go` prices come from models.dev and read as `provider` prices
  with `estimate` confidence; save them like any catalog price. A model with
  `null` prices (one models.dev does not list, a `custom` provider, or a
  catalog whose price source is unavailable) is saved with override prices the
  owner confirms and no `catalogPriceRef`; a later update that changes its
  model or credential then needs the owner (`price_unverified_for_new_route`).

<!-- cloudharness-example:model_catalog_search
{"provider":"openrouter","query":"sonnet","capability":"tools","limit":10}
-->

<!-- cloudharness-tool:model_connection_verify -->
### `model_connection_verify`

- Send exactly one of `profileId` (a saved profile, checked as saved) or
  `credentialId` with `model` (a draft route; add `apiMode`, and
  `customUpstreamUrl` for a Custom credential).
- Probes authentication, model access, and streaming inference; `checks.tools`
  opts into a tool-call probe. It spends a few provider tokens, is audited, and
  shares a per-principal rate limit with the Dashboard: `LIMIT_EXCEEDED` is
  retryable after the few seconds the message names.
- A verified draft returns `verificationRef`. Pass it unchanged to the save
  with the identical route to keep the result on the new revision; any other
  route saves as not verified.
- A Custom `customUpstreamUrl` must already be used by one of your profiles on
  that credential, else `OWNER_APPROVAL_REQUIRED` and nothing is sent.

<!-- cloudharness-example:model_connection_verify
{"credentialId":"cred_0123456789abcdef0123456789abcdef","model":"anthropic/claude-sonnet-4.5","apiMode":"chat-completions"}
-->

<!-- cloudharness-example:model_connection_verify
{"profileId":"reviewer","checks":{"tools":true}}
-->

<!-- cloudharness-tool:model_profile_list -->
### `model_profile_list`

- Lists your profiles with `status`, `generation`, the active revision (model,
  API mode, pinned prices, limits, `maxProxyOperations`), the last connection
  check, and a repricing review against the cached catalog.
- Read `generation` here before every `model_profile_update`.
- Optional `profileId` narrows the list to one profile.

<!-- cloudharness-tool:model_profile_validate -->
### `model_profile_validate`

- A dry run that writes nothing. `action: "create"` takes the
  `model_profile_create` fields without `idempotencyKey`; `action: "update"`
  takes `profileId`, `expectedGeneration`, and the changed fields.
- Returns `valid`, `issues`, the `revision` a save would write, a pricing
  review, `verificationAttachable`, and `escalations` with
  `ownerApprovalRequiredOverMcp`. A non-empty `escalations` list is exactly
  what an MCP save would refuse: drop those changes or hand them to the owner.
- `statusAfterSaveOverMcp` is `DISABLED` for a create and `unchanged` for an
  update.

<!-- cloudharness-example:model_profile_validate
{"action":"update","profileId":"reviewer","expectedGeneration":2,"displayName":"Reviewer (cheap)","limits":{"maxInputTokens":100000,"maxOutputTokens":8000,"maxCostMicros":500000}}
-->

<!-- cloudharness-tool:model_profile_create -->
### `model_profile_create`

- Required: `idempotencyKey`, `profileId`, `displayName`, `credentialId`,
  `model`, `apiMode`, `pricing`, `limits`, and `maxProxyOperations`. Optional:
  `customUpstreamUrl` (Custom only), `catalogPriceRef`, `verificationRef`.
- The result is `{profile, replayed, activation: "dashboard_required"}` and the
  profile is always `DISABLED`. Tell the owner to review its limits, prices,
  and proxy operations and activate it: a create is not checked against a
  baseline, so activation is the owner's approval of the whole revision.
- Retry an unknown outcome with the same key and identical input: you get the
  first result with `replayed: true` for 24 hours. The same key with other
  input returns `CONFLICT`; a refused call records nothing, so its key is free.
- `CONFLICT` without a key reuse means the `profileId` is taken; pick another.
- A Custom upstream URL none of your profiles on that credential uses returns
  `OWNER_APPROVAL_REQUIRED`.

<!-- cloudharness-example:model_profile_create
{"idempotencyKey":"create-reviewer-profile-1","profileId":"reviewer","displayName":"Reviewer","credentialId":"cred_0123456789abcdef0123456789abcdef","model":"anthropic/claude-sonnet-4.5","apiMode":"chat-completions","catalogPriceRef":{"sourceModelId":"anthropic/claude-sonnet-4.5"},"pricing":{"inputMicrosPerMillionTokens":3000000,"outputMicrosPerMillionTokens":15000000},"limits":{"maxInputTokens":200000,"maxOutputTokens":16000,"maxCostMicros":2000000},"maxProxyOperations":["files_read","grep_search"]}
-->

<!-- cloudharness-tool:model_profile_update -->
### `model_profile_update`

- Required: `profileId`, `expectedGeneration` from `model_profile_list`, and
  `idempotencyKey`. Omitted fields keep their current values; the profile's
  status never changes. An `ACTIVE` profile serves the new revision to new
  spawns at once.
- A moved generation returns `CONFLICT`: re-read with `model_profile_list`,
  re-check the change, and retry with a new key. Same-key replay works as for
  create.
- Lowering limits, narrowing proxy operations, renaming, changing the model on
  the same credential with catalog-verified prices, or moving to a
  catalog-verified price is allowed. Changing `credentialId` is not. Everything listed under Escalations above
  returns `OWNER_APPROVAL_REQUIRED`, whatever the profile status.

<!-- cloudharness-example:model_profile_update
{"profileId":"reviewer","expectedGeneration":2,"idempotencyKey":"update-reviewer-limits-1","limits":{"maxInputTokens":100000,"maxOutputTokens":8000,"maxCostMicros":500000}}
-->

<!-- cloudharness-tool:model_spend_summary -->
### `model_spend_summary`

- Read-only. Returns `summary.windows` for the current UTC day and month, for
  your whole principal and for each profile with spend or a policy, with
  estimated settled, reserved (open runs at their full cap), and unreconciled
  micro-USD, plus the owner's `policies` and each window's `thresholdState`.
- Figures are gateway estimates from pinned profile prices, not provider bills.
- Use it before a large `agent_spawn` to pick a `maxCostMicros` that fits. No
  tool changes a policy; only the owner can, on the Dashboard.
- Optional `period` (`day` or `month`) narrows windows and policies.

<!-- cloudharness-example:model_spend_summary
{"period":"day"}
-->
