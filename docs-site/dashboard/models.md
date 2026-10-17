# Subagent Models & Provider Credentials

The **Subagent Models** dashboard (`/dashboard/models`) allows authenticated operators to manage LLM provider credentials, model routing profiles, token pricing, budget limits, and safe tool permissions for coding subagents (`agent_*` tools).

## Architecture & Security Boundary

- **Zero Credential Exposure:** Provider API keys are write-only, encrypted at rest using AES-256-GCM via `SecretKeyring`, and projected dynamically into Model Gateway RAM. Provider secrets are never written to workspace directories or injected into subagent containers.
- **Dynamic Hot Reload:** Changes to model profiles and credentials take effect immediately without requiring service restarts or container redeployments.
- **Lease Pinning:** Subagents running with an active capability lease remain bound to their exact immutable profile revision. When rotating a credential, in-flight requests safely complete with the prior key while subsequent requests seamlessly use the new key.

## Managing Provider Credentials

Operators can configure API keys for these providers. Endpoints, accepted auth headers, and
supported API modes come from the provider registry
([`packages/contracts/src/model-provider-registry.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-provider-registry.ts)),
which authenticated dashboard sessions can read at `GET /api/v1/model-providers`.

| Provider | Chat Completions | Responses | Auth header |
| --- | --- | --- | --- |
| OpenAI | `api.openai.com/v1/chat/completions` | `api.openai.com/v1/responses` | Bearer |
| Anthropic Claude | `api.anthropic.com/v1/chat/completions` (OpenAI SDK compatibility) | Not supported | Bearer or `x-api-key` |
| OpenRouter | `openrouter.ai/api/v1/chat/completions` | `openrouter.ai/api/v1/responses` | Bearer |
| Google Gemini | `generativelanguage.googleapis.com/v1beta/openai/chat/completions` | Not supported | Bearer |
| DeepSeek | `api.deepseek.com/chat/completions` | Not supported | Bearer |
| Custom | Your HTTPS URL on port 443 naming one fixed request path, with no userinfo, query string, or fragment (SSRF-validated; endpoints that need a query string such as `?api-version=` are not supported, because the gateway sends only the URL path) | Your HTTPS URL | Bearer or `x-api-key` |

Saving a profile with an API mode its provider does not offer, or a credential with an auth
header its provider does not accept, is refused with a message naming the supported values.
A credential stored with an auth header its provider no longer accepts cannot back a profile:
add a new credential with the supported header and select it on the profile.

> **Gemini profiles created before this fix** were routed to a path Google does not serve and
> failed with 404. Profile revisions are immutable, so edit and save each Gemini profile once:
> the new revision uses the documented `v1beta/openai` endpoint. If the profile used the
> Responses API mode, switch it to Chat Completions in the same edit. If its credential was
> saved with the `x-api-key` header, add a new Gemini credential (Bearer) and select it, then
> delete the old credential.

### Adding a Credential
1. Navigate to **Configuration $\rightarrow$ Models** in the sidebar.
2. Click **+ Add credential**.
3. Select the provider, enter a label, and paste your API key.
4. Click **Save credential**. Keys are write-only and cannot be viewed in plaintext after submission.

### Rotating a Credential
1. Locate the credential in the **Provider Credentials** table.
2. Click **Rotate**.
3. Enter the new API key and confirm. The active version increments atomically in memory.

## Model Catalog

The catalog answers "which models can this credential use, and what do they cost?" so a
profile can be filled from a search instead of typed from memory. The runner builds it from
two sources and returns only model metadata; the credential never leaves the runner.

| Source | What it proves | Shared? |
| --- | --- | --- |
| The provider's own models endpoint, called with the selected credential and the auth header it was saved with | The model is available to that key (`listed_for_credential`) | No: only the principal that owns the credential, and only for its current key version |
| OpenRouter's public models list | Display names, context and output limits, capabilities, and prices | Yes: it is public metadata |

The provider listing is cached for a shorter time than the public list because it changes
with your account. The cache lifetimes, failure backoff, fetch deadline, and refresh limits
are owned by
[`apps/runner/src/model-catalog/model-catalog-service.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/apps/runner/src/model-catalog/model-catalog-service.ts)
and
[`apps/runner/src/model-catalog/provider-catalog.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/apps/runner/src/model-catalog/provider-catalog.ts).

- **OpenRouter credentials** list OpenRouter's models directly, and their prices are the ones
  OpenRouter bills: confidence `exact`.
- **Direct vendors** (OpenAI, Anthropic, Gemini, DeepSeek) take their model IDs from the
  vendor's own listing. OpenRouter metadata is attached when the vendor ID matches the
  OpenRouter `vendor/model` ID (`canonicalModelId`), and its price is labelled `estimate`
  because the vendor bills you, not OpenRouter. OpenRouter IDs are never sent to a vendor.
- **Without a credential**, or when the vendor listing fails, OpenRouter's public entries for
  that vendor stand in with availability `public_catalog`. These IDs are unverified: they
  are OpenRouter's naming with the vendor prefix removed, and nothing has confirmed that your
  key can call them. Check a `public_catalog` model against the provider before saving a
  profile with it; the profile wizard enforces that check.
- **Custom providers** have no catalog; enter the model ID yourself.

Every price carries its provenance: the source (`provider`, `openrouter`, `user`, or `none`
when no source published a price), the
source model ID, when it was retrieved, and its confidence (`exact`, `estimate`, or
`unknown`). An unknown price is `null`, never zero, so a missing price is never treated as
free. Capabilities (tools, reasoning, vision) are `reported` only when provider or OpenRouter
metadata says so.

Catalog prices follow the same rules as [saved revision prices](#revision-pricing-and-provenance),
so a catalog price can be saved unchanged:

- **Cache writes.** OpenRouter publishes a default and a one-hour cache-write price. The
  catalog keeps the higher of the two, because the agent runtime can ask for long retention
  and the usage a provider reports does not say which write was billed.
- **Tiers.** An OpenRouter price override whose only condition is a minimum prompt length
  (`min_prompt_tokens`) becomes a long-prompt tier in `tiers`. A tier never inherits a
  base price: one without its own input and output price is not used, and a cache price it
  does not publish stays unknown.
- **Conditional pricing.** Tiers are all or nothing. When any override cannot become a
  tier (it has another condition or lacks its own input and output price), when there are
  more than four, when two share a threshold, or when the tiers would break the tier rules
  once unknown cache prices are resolved for the selected provider, the entry lists no tiers
  at all and sets `hasConditionalPricing`. The listed flat price then understates or
  overstates some requests, but a partial tier set is never shown as complete.

### Freshness and refresh

Each result reports `freshness` per source. `fresh` means every source answered within its
time-to-live. `stale` means at least one source failed and the last good copy, kept across
runner restarts, is being served; the source shows an error category such as
`authentication`, `rate_limited`, or `timeout`. `unavailable` means there is nothing to show
yet. After a failure the runner backs off before asking that source again. A credential that
is disabled or revoked is never sent to the provider; its listing reports
`credential_unavailable`.

The dashboard reads the catalog at `GET /api/v1/model-catalog` (query parameters `provider`,
`credentialId`, `q`, `cursor`, `limit`, `capability`) and forces a refresh with
`POST /api/v1/model-catalog/refresh`. A refresh skips the cache and is rate limited per
provider and credential. The public OpenRouter list is shared, so it has its own limit:
refreshing several credentials in a row re-fetches each credential's listing but forces the
public list only once per window. Schemas live in
[`packages/contracts/src/model-catalog-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-catalog-schemas.ts).

## Verifying a Connection

A connection check proves that a credential, model, and API mode work before a subagent
depends on them. The runner sends the requests itself, so the key never reaches the
browser, the API, or a workspace. Request it with
`POST /dashboard/api/v1/model-connection/verify` (operation `model_connection_verify`;
the input and result schemas are in
[`packages/contracts/src/model-verification-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-verification-schemas.ts)):

- `{ "profileId": "coding-fast" }` checks a saved profile's active revision: its credential,
  model, API mode, and upstream.
- `{ "credentialId": "cred_…", "model": "…", "apiMode": "…", "customUpstreamUrl": "…" }`
  checks unsaved settings. A draft never creates or changes a profile, revision, or
  credential. Without a model only the key is checked. A check of a model whose route
  resolves includes a `verificationRef`; passing it as `verificationRef` when creating or
  updating a profile with the same route keeps the result on the new revision (see
  [the profile wizard](#the-profile-wizard)). A save that matches uses the reference up, and
  so does a save whose route differs: that save is not refused, its profile simply has no
  `lastVerification`, and the check must be run again. A save that fails leaves the
  reference unused. A draft for a Custom credential
  sends the key to the `customUpstreamUrl` you submit, exactly as saving a profile with that
  upstream would, so only submit an upstream you trust with the key.
- `"checks": { "inference": false, "tools": true }` turns the paid checks off or on.
  Inference runs by default when a model is known; the tool-call check is opt-in.

### What is checked

| Check | How |
| --- | --- |
| `authentication` | Lists the provider's models with the key (Anthropic uses its native `x-api-key` header). OpenRouter's list is public, so its key is checked at `GET /api/v1/key`. Custom providers skip this and rely on inference. A restricted key that may not list models is `limited` (`access`), not failed; when inference runs, it decides whether the key works. |
| `model_access` | The model ID appears in the listing (Gemini's `models/` prefix is ignored), or the model answered. A model missing from a complete listing fails only when no inference ran or the provider answered not found; if inference ran but proved nothing (rate limit, quota, timeout), or the listing was partial, it is `limited`. |
| `protocol` | A tiny streamed request with a small output cap returns events of the expected API family: `choices[].delta` for Chat Completions, `response.*` for Responses. The cap uses the same field the model gateway sends for that provider. |
| `streaming_inference` | The stream finishes with a finish reason, `[DONE]`, or a completed response; token usage is captured when the provider reports it. An error inside the stream is classified like an HTTP error. |
| `tool_call` | Optional. Forces a call to a harmless synthetic `report_status` tool. |

### Outcomes

- `verified`: every check that ran passed.
- `limited`: nothing proved the configuration wrong, but something could not be proven:
  a rate limit (`rate_limited`), exhausted credit (`quota`), `timeout`, `network`, a provider
  outage (`upstream`), or a model that does not accept tool calls. A rate limit or quota
  answer never marks a model unsupported. Retry later.
- `failed`: the provider proved the settings wrong. `auth` is a rejected key (Gemini reports
  this as HTTP 400 or 403), `access` is a key without permission, `not_found` is an unknown
  model or path, `unsupported_protocol` is a refused request shape or the wrong API mode,
  `invalid_response` is an answer that is not a usable stream, and `forbidden_host` is an
  upstream that resolves to a private address.
- `not_tested`: no check ran.

Each check reports its `errorCategory`, `httpStatus`, and a short provider message with
any key material removed.

### Cost and limits

The inference and tool checks spend a small, capped number of tokens on the provider
account behind the key. For a saved profile the result includes `estimatedCostMicros` from
the revision's pricing; drafts report `null`. Checks are rate limited per principal, and a
whole check, name resolution included, runs under one deadline that is shorter than the
dashboard's request timeout; checks that run out of time are reported as `limited`
(`timeout`). The limits and caps are owned by
[`apps/runner/src/model-verification/`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/apps/runner/src/model-verification/).
Every check is recorded in the audit log as `model_connection.verified` with its outcome,
target, credential, model, API mode, elapsed time, and token counts, never the key.

The latest result appears as `lastVerification` on credentials and profiles. A profile's
result belongs to the revision it checked, so saving a new revision shows it as not verified
again, unless the save names a matching draft check; rotating a key does the same for the
credential. Deleting a profile or credential
deletes its results.

## Configuring Model Profiles

Model profiles define how subagents interact with LLMs:
- **Model Name:** The provider-specific model identifier (e.g. `gpt-5.2-codex`, `claude-3.7-sonnet`).
- **API Mode:** `chat-completions` (`/v1/chat/completions`) or `responses` (`/v1/responses`), limited to the modes the provider offers.
- **Custom upstream URL:** Required for a Custom credential. Editing the profile keeps its current URL unless you enter a new one; changing the API mode or switching to a different Custom credential requires entering the URL again.
- **Token Pricing:** Input and output token pricing in USD per 1M tokens, plus optional cache prices and long-prompt tiers (see [Revision pricing and provenance](#revision-pricing-and-provenance)).
- **Budget Limits:** Hard limits for maximum input tokens, output tokens, and cost per agent execution.
- **Allowed Proxy Operations:** Hard ceiling on permitted file and search operations from the exact 10 safe tools (`files_list`, `files_read`, `files_write`, `files_apply_patch`, `files_delete`, `files_move`, `files_mkdir`, `grep_search`, `symbols_search`, `symbols_references`).

### Revision pricing and provenance

Every saved revision pins its prices. Prices are integer micro-USD per one million tokens,
and the contract lives in
[`packages/contracts/src/model-pricing.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-pricing.ts)
and `AgentModelPricingSchema` in
[`model-profile-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-profile-schemas.ts).

- **Cache prices.** `cacheReadMicrosPerMillionTokens` and `cacheWriteMicrosPerMillionTokens`
  are optional. Leaving one out, or sending `null`, records it as unknown, never as free.
- **Tiers.** `tiers` holds up to four long-prompt price levels; an empty list means flat
  pricing. Each tier applies once a request's prompt reaches its `minPromptTokens` (at most
  10,000,000); the base prices cover shorter prompts. Thresholds must strictly ascend, and
  no tier may charge less than the level below it. That rule applies to the prices the
  gateway charges, after unknown cache prices are resolved for the key's provider (see the
  table below). A save is refused with `INVALID_INPUT` when, for example, a tier states a
  cache read below the base's unstated one (which costs the base input price), or the base
  states a cache write and a tier leaves it out. State the cache prices on every level to
  avoid this.
- **Provenance.** `priceProvenance` records where the prices came from: `source`
  (`provider`, `openrouter`, `user`, or `none`), `sourceModelId`, `retrievedAt`,
  `confidence` (`exact`, `estimate`, or `unknown`), and `isOverride`. A client cannot set
  provenance or confidence; the runner assigns them when the revision is saved:
  - A save that sends `catalogPriceRef: { "sourceModelId": "vendor/model" }` names the
    catalog model its prices came from. The reference must be the catalog entry for the
    model the revision routes to: for an OpenRouter profile, that model ID itself; for a
    direct vendor, the catalog model the profile's model matches (the one the catalog
    search shows for it). The runner resolves the routed model in its own cached catalog,
    without a network call. When the reference names that entry and the submitted input,
    output, cache read, cache write, and tier prices all equal its price, the catalog's
    provenance is copied with `isOverride: false`: confidence `exact` for OpenRouter,
    `estimate` for a direct vendor.
  - Pricing that differs in any price or tier is your override: `source: "user"`,
    `isOverride: true`, confidence `unknown`, with the routed model's catalog entry and its
    retrieval time kept for context.
  - A save without a reference, with a reference to any other model, or for a model the
    cached catalog does not list, is recorded as your override with no source model.
    Revisions saved before provenance existed read back the same way.

**Pinned prices never drift.** Revisions are immutable, and catalog refreshes never write
to them. An edit that does not submit pricing copies the current revision's prices, cache
prices, tiers, and provenance unchanged, and keeps its limits unless the edit changes them.
Submitting only the input and output prices, unchanged, counts as not submitting pricing.
If the edit changes the model or the key, the copied prices are recorded as your override
of `unknown` confidence, because they were set for the previous model. A key for another
provider can resolve unknown cache prices differently, so switching keys is refused with
`INVALID_INPUT` when the copied tiers would break the rule above. Any other submitted
pricing replaces all of them: send the cache prices and tiers again to keep them. The new
prices get provenance by the rules above, so they are your override unless they match the
catalog price they reference.

**Repricing review.** Listing profiles (`model_profile_list`) adds a `pricingReview` to
each profile with an active revision. It compares the revision's pinned prices with the
cached catalog price for the model the revision routes to, matched the way the catalog
search matches it; the stored `sourceModelId` is never used to pick the price. The schema is `ModelPricingReviewSchema` in
[`model-profile-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-profile-schemas.ts).

- `repriced`: an input, output, cache read, cache write, or tier price differs from the
  catalog by at least `REPRICING_WARNING_PERCENT` (10%, in
  [`model-catalog-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-catalog-schemas.ts))
  in either direction; a pinned price of zero now has a catalog price; a pinned cache price
  is no longer published by the catalog (listed with `catalog: null`); a tier exists on
  only one side. A rise means cost estimates and
  caps are understated, a fall means they are overstated. A cache price the revision leaves
  unknown is not compared, because it is charged at the conservative default below. `changes` lists each difference with the pinned price, the
  catalog price, and the signed percentage.
- `current`: nothing differs by that much.
- `unknown`: the runner has no cached catalog price for the model, for example before the
  catalog was first searched, for a Custom provider, or for a model the catalog does not
  list.

The state reflects only prices a revision can hold, so editing the profile to the catalog
price always clears `repriced`. Catalog conditional pricing that no revision can express
is reported separately as `catalogHasConditionalPricing: true`, an informational note: for
some requests the provider charges a price the revision does not record, which may be
lower or higher than the pinned estimate. It never changes `state`, and a profile whose
prices match the catalog reads `current` with the note set.

`isOverride` repeats the revision's provenance: for your own prices the difference is
information, not a sign that the price is stale. Listing never makes a network call: the
review reads the last cached catalog, whatever its age. The OpenRouter catalog is kept
across restarts, except that a copy saved in an older format is not used: until the next
catalog search fetches a new one, reviews of every catalog-priced profile, OpenRouter or
direct vendor, read `unknown`, and a list reads the saved copy at most once until that fetch
succeeds. It is computed
on every list and never stored, so a catalog refresh changes the review but never the pinned
prices, provenance, or limits. To take a new catalog price, edit the profile and save it.

**How unknown prices are charged.** The gateway and the agent's own cost report use the
same concrete prices, resolved when the runner sends the revision to the gateway and when it
starts an agent:

| Price | When unknown |
| --- | --- |
| Cache read | The input price of the same level |
| Cache write, OpenRouter and Custom | Twice the input price of the same level |
| Cache write, OpenAI, Anthropic, Gemini, DeepSeek | The input price of the same level |

Whether a provider bills cache writes is the `billsCacheWrites` field of the
[provider registry](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-provider-registry.ts).
These defaults can only over-charge; enter the real price to make estimates exact. The
profile list shows the prices as saved, not the resolved defaults. An agent's self-reported
cost uses the base prices; the gateway applies tiers.

Static profiles from the runner configuration are not tied to a registry provider: their
unknown cache prices, read and write alike, cost the input price, which is how the gateway
charges a static profile file.

### The profile wizard

**Add profile** opens a five-step wizard. **Back** returns to an earlier step and keeps
what you entered, except an API key you have not sent yet: paste it again. Choosing a
different provider clears the chosen model and any price that came with it. A failed request
keeps every field so you can retry, and the dialog stays open while a
key, connection check, or save is in flight.

1. **Provider:** pick the provider. The list and each provider's API modes come from
   `GET /api/v1/model-providers`.
2. **Connect:** choose a saved key for that provider or add a new one. A new key is sent
   once, write-only, and the field is cleared as soon as it is stored or the dialog closes;
   the wizard never shows it or keeps it anywhere else.
3. **Model:** search the [model catalog](#model-catalog) with the combobox (arrow keys move
   through results, Enter selects, Escape closes). Each result shows its availability:
   listed for your key, or public catalog only. The catalog's freshness is shown below the
   search, so a stale or unavailable catalog is visible rather than silent. If the model is
   not listed, use the **custom model ID** option. Custom providers have no catalog, so this
   step is a plain **Model ID** field. Typing after you chose a model clears the choice until
   you pick again.
4. **Review:** the selected model fills the display name and prices. Each price shows where
   it came from: the catalog source with its confidence and retrieval time, a price you
   typed, or, when editing or duplicating, the price saved on the profile. A custom model ID
   never inherits the previous model's price. A price no source published stays **Unknown**:
   enter it yourself, and enter `0` only for a model that is really free. A catalog price
   you keep unedited is saved whole, cache prices and long-prompt tiers included, with a
   `catalogPriceRef` to its catalog model. A cache price the catalog does not publish is
   sent as `null` and flat pricing as an empty tier list, so the save replaces every saved
   price rather than keeping an old cache price or tier. Once you edit a price, only the
   input and output prices you typed are sent, as your override. **Saved as** tells you which before you
   save: **Catalog price**, **Custom price (override)**, or, for an edit that keeps the
   saved input and output prices for the same model and key, **Saved price (unchanged)**
   (the saved prices and their provenance are kept). Choose a permission preset here. **Advanced** holds the profile ID (derived
   from the model and made unique among your profiles), the API mode, the custom upstream
   URL (Custom only), per-run limits, prices, and the model ID.
5. **Verify and save:** run a [connection check](#verifying-a-connection) against the
   unsaved settings (the tool-call check is optional), then save.

**Permission presets** cover the 10 safe operations:

| Preset | Operations |
| --- | --- |
| Read only | `files_list`, `files_read`, `grep_search`, `symbols_search`, `symbols_references` |
| Code editing | Read only plus `files_write`, `files_apply_patch`, `files_move`, `files_mkdir` |
| Custom | Any combination you choose |

Before saving, the wizard shows the full permission change: operations added, removed, and
kept compared with the saved revision (or with nothing, for a new or duplicated profile).

**Saving is gated.** The wizard refuses to save until:

- the connection for the current key, model, API mode, and upstream is verified, or you tick
  **Save without a verified connection**. A model that came only from the public catalog
  is unconfirmed for your key, so it always needs one or the other. Both apply only to the
  route they were made for: changing the key, model, API mode, or upstream asks again;
- you tick the acknowledgement for any newly allowed operation that changes files
  (`files_write`, `files_apply_patch`, `files_delete`, `files_move`, `files_mkdir`). No
  preset or edit turns these on without that tick.

**Edit** and **Duplicate** open the wizard at the review step with the existing values.
An edit keeps the profile ID and counts as verified only when the route is unchanged and the
saved revision was verified. A duplicate gets a new unique ID and starts with no operations
inherited as already approved.

A connection check run inside the wizard is kept on the revision the save creates, so a
just-checked profile does not need a second paid check. The runner holds the draft result
itself and gives the browser only an opaque, single-use `verificationRef` that expires after
a short time (`DRAFT_VERIFICATION_TTL_MS` in
[`draft-verification-store.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/apps/runner/src/model-verification/draft-verification-store.ts));
the wizard sends it with the save. The runner keeps the result only when the
save is by the same principal and uses exactly the checked credential, key version, model,
API mode, and resolved upstream. Otherwise the save still succeeds and the profile shows
**Not verified** until you run **Verify** from the list. A runner restart also forgets
pending draft results.

### The profile list

Each profile shows its provider and model, verification status and when it was checked,
the key it uses, its prices, and its per-run cost and token limits. Actions are **Verify**
(checks the saved profile), **Edit**, **Duplicate**, **Disable** or **Activate**, and
**Delete**.

A profile created by an agent over MCP (`model_profile_create`) is always saved
**Disabled**. It routes no subagent until you review it here and choose **Activate**. A new
profile has nothing to compare with, so only a Custom URL the key has not used yet stops an
MCP create: the limits, prices, and proxy operations are whatever the agent chose.
**Activate** approves that whole revision, so check them before you activate it. An MCP
update that would move the profile to another key, raise spend, or widen permissions is
refused with `OWNER_APPROVAL_REQUIRED`; make that change here instead. See
[API and MCP examples](/reference/model-providers#api-and-mcp-examples) for the MCP tools.

The **Price per 1M (in / out)** column shows the revision's pinned prices as saved:

- the input and output prices, then **cache read** and **cache write**, then one line per
  long-prompt tier (**From N prompt tokens:** with that tier's prices);
- a price the revision leaves unknown reads **Unknown (charged conservatively)**, never
  `$0`, because the gateway charges it at the conservative default in
  [How unknown prices are charged](#revision-pricing-and-provenance);
- where the prices came from: a **Catalog price** or **Custom price (override)** badge, then
  **Source:** (OpenRouter, provider, or entered by you), **confidence:** (`exact`,
  `estimate`, or `unknown`), and **retrieved** with the catalog's retrieval time when it has
  one.

When the [repricing review](#revision-pricing-and-provenance) reads `repriced`, a warning
appears under the price: **Catalog price changed by N% since saved**, where N is the largest
change the review measured (**Catalog price changed since saved** when no percentage
applies, for example a new tier). For a profile whose price is your override, the warning
reads **Differs from catalog** instead, because the difference is your choice. Either way,
**Review catalog price** opens the edit form with the catalog's current price filled in;
nothing is saved until you choose **Save changes**. Saving it unedited replaces every saved
price, cache prices and tiers included, and the runner records it as the catalog's price
when it still matches the runner's cached catalog price (otherwise it is saved as your
override). When the catalog has no current price for the model, the form says **The catalog
has no current price for this model** and keeps the saved price; when the catalog cannot be
read, the form shows the error and keeps the saved price.

When the review reads `unknown`, the list says **No catalog price to compare with**. This
note does not mean the saved price is wrong: the runner may not have loaded the catalog yet
(for example just after a restart), or the catalog may not list the model. Profiles of a
provider without a catalog, such as Custom, never show it. For a
`repriced` or `unknown` review whose catalog has a retrieval time, the list adds **Compared
with the catalog from** that time, so you can tell how old the comparison is. When the
catalog also prices the model by conditions a saved price cannot express, the list adds
**The catalog also prices this model by conditions a saved price cannot express, so the
charge can differ from this estimate.**

### Gateway status

The badge beside **Model profiles** reads `GET /api/v1/agent-model-config-status`
(schema `ModelConfigStatusSchema` in
[`model-profile-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-profile-schemas.ts)):

- **Gateway synchronized** (`gatewaySynced: true`) means the Model Gateway answered and the
  last snapshot it applied matches the runner's current profile and credential snapshot: the
  digest it reports equals the digest of the snapshot the runner would send now. The gateway
  merges each snapshot into what it already holds, so profiles and credentials removed since an
  earlier snapshot can remain loaded there; the badge does not claim otherwise. An unreachable
  gateway, or one whose repair push failed, shows **Gateway sync pending**.
- **Last successful sync** (`lastSyncTime`) is when the runner last pushed a snapshot
  successfully: after a dashboard change, at runner startup, before an agent launch, or to
  repair the gateway. It is kept in memory, so it reads **Never since the runner started**
  (`null`) until the restarted runner pushes again. The badge can then still read
  **Gateway synchronized**, because the gateway kept the snapshot the previous runner sent.
- The error line (`error`) explains an unreachable gateway or a failed last push. A later
  successful push clears it, and it is not shown while the gateway's last applied snapshot
  matches.

When the digests differ, reading the status pushes the current snapshot once and reports the
result. This repairs a gateway that restarted, missed a failed push, or holds a snapshot that
changed without a push, such as when an agent pinned to an older profile revision ends. The
agent manager makes the same comparison before it launches an agent on a dashboard-managed
profile, and refuses the launch as retryable when the gateway cannot be brought in sync.

The runner serializes every snapshot push, and it builds each snapshot just before sending it.
A push therefore always carries the latest saved state, such as a key rotated a moment earlier,
and a slower push can never replace a newer snapshot with an older one.
Requests that arrive while a push is already waiting share that push, so a status read or an
agent launch waits for at most the push in progress and one more.

## Spend policies

A spend policy caps the estimated model spend of a UTC day or month. A policy without a
profile covers every subagent run of your account; a profile policy covers the runs of one
saved profile. Each scope has at most one daily and one monthly policy. A static profile
from the runner configuration cannot carry its own policy, so its runs count only against
the account policies.

The figures are estimates, never provider billing:

- When a spawn is admitted, its whole `maxCostMicros` cap is reserved in the window of that
  moment, and the whole run counts in that day and month even if it ends after midnight
  UTC. Spend near a window boundary can therefore exceed one window's limit.
- The cap stays reserved until the run ends and its gateway lease settles. The run then
  counts at the cost the model gateway charged.
- A run whose gateway accounting was lost, for example to a gateway restart, stays at its
  full cap and is reported as **unreconciled**. It never shrinks back to a smaller figure.

A spawn whose cap does not fit in a policy's remaining headroom is refused with
`LIMIT_EXCEEDED` and creates no agent. A policy never changes a run's own cost cap, which
the model gateway still enforces.

A profile policy, and the spend counted in its windows, belong to the profile id, not to
one profile record. Deleting a profile keeps its policies and its spend, and a profile
created again with the same id inherits both. Delete the policies yourself if the new
profile should start without them.

### The Spend and limits panel

The **Spend and limits** panel on the Models & Budgets page reads
`GET /dashboard/api/v1/model-spend`. Every amount in it carries an **Estimate** tag, and
the help note under the heading says that a run's cap is reserved until the run ends. Each
row is one window, **Today (UTC)** or **This month (UTC)**, for **All runs** (your account)
or for one profile, shown as its display name and id. A profile that was deleted but still
has a policy or spend reads **(profile deleted)**.

| Column | Shows |
| --- | --- |
| **Settled** | Runs settled at the cost the model gateway charged |
| **Reserved** | Open runs, each at its full cap |
| **Unreconciled** | Runs whose gateway accounting was lost, each at its full cap |
| **Total** | The three added together; this is what a limit is compared with |
| **Limit** | The policy's limit and **warn at N%**, or **None** |
| **State** | **OK**, **Warning** (from the warn percentage), **Exceeded** (at the limit), or **No limit** |

The state is written as a word; its green, amber, or red pill only repeats it.

**Adding a limit.** Use **Set limit** on a row, or the **Add a spend limit** form under
the table. Choose **Applies to** (**All runs (account)** or a saved profile), **Period**
(**Daily (UTC day)** or **Monthly (UTC month)**), **Limit (USD)**, and **Warn at (% of
limit)** (80 unless you change it), then **Add limit**. The limit is typed in US dollars
with at most six decimal places, above $0 and at most $1,000,000; a leading `$`, surrounding
spaces, leading zeros, and a bare fraction such as `.5` are accepted. The browser converts it
to whole micro-dollars without rounding, and refuses a negative amount or a seventh
decimal place before anything is sent. A scope and period that already has a limit is
refused with the server's message; the panel reloads so you can see and edit that limit
instead.

**Editing a limit.** **Edit limit** opens the **Edit spend limit** form with the stored
values. A limit keeps its scope and period, so only **Limit (USD)** and **Warn at (% of
limit)** can change; to move it, delete it and add a new one. **Save limit** sends the
limit with the version you opened. If someone changed or deleted it meanwhile, the panel
shows the server's message, reloads, and fills the form with the current values for you to
review and save again. If the limit was deleted and a new one added for the same scope and
period, the form opens that limit instead; if none exists any more, the form turns into
**Add a spend limit** with your typed values kept.

**Deleting a limit.** **Delete limit** asks for confirmation, naming the period and the
scope as the **Applies to** column does (**All runs**, the profile's display name followed by
its ID in parentheses, or the ID followed by **(profile deleted)**), then removes the limit.
Recorded spend is kept. A limit that changed or was already deleted is refused with the
server's message and the panel reloads.

### Spend routes

Over MCP, `model_spend_summary` reads the same estimated spend and the policies you set
here, but no MCP tool creates, changes, or deletes a policy. Scripts can use the dashboard
routes the panel uses. Each
needs a signed-in dashboard session. A change also needs the session cookie,
an `x-csrf-token` header set to the `csrfToken` field of the `GET /dashboard/api/v1/session`
response, `Content-Type: application/json`, and the dashboard's own `Origin`; the
dashboard page sends all of these itself.

- `GET /dashboard/api/v1/model-spend` returns the summary and the policies. For the
  current UTC day and month, the summary lists your account and every saved profile that
  has a policy or spend this month. Each window reports `estimatedSettledMicros`,
  `estimatedReservedMicros` (open runs at their cap), and `estimatedUnreconciledMicros`,
  its start and end, its policy, and a `thresholdState` of `ok`, `warning` (from the
  policy's `warnPercent`), or `exceeded` (at the limit).
- `GET /dashboard/api/v1/model-spend/policies` returns only the policies.
- `PUT /dashboard/api/v1/model-spend/policies` creates or updates a policy: `{ "policyId"?,
  "profileId"?, "period": "day" | "month", "limitMicros", "warnPercent"?,
  "expectedGeneration"? }`.
  - To create one, send neither `policyId` nor `expectedGeneration`. A new profile policy
    must name one of your saved profiles, and a scope and period that already has a policy
    is refused as a conflict. `warnPercent` defaults to 80.
  - To update one, send its `policyId` and current `generation` as `expectedGeneration`,
    with the scope and period it already has; a policy cannot move to another scope or
    period. A changed generation, or a policy that was deleted and created again for the
    same scope and period, is refused as a conflict, so reload the policy and retry. A
    policy that was deleted and not replaced is refused as not found; create it again. An
    update that omits `warnPercent` keeps the current value.
- `DELETE /dashboard/api/v1/model-spend/policies/<id>` with `{ "expectedGeneration" }`
  deletes a policy. A policy whose profile was deleted is still listed so you can remove
  it.

Every policy change is recorded in the audit log with its id, period, and limit. The
limits on values are in
[`packages/contracts/src/model-spend-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-spend-schemas.ts).

## Where this page lives now

The page is labelled **Models & Budgets** in the navigation and still lives at
`/dashboard/models`, so existing links keep working. It follows the shared resource-page
layout: the page heading and help come from the dashboard's page registry, the single
accented action (**Add profile**) and its secondary (**Add credential**) sit in the header
action slot, and both open dialogs rather than permanent forms under the list. Identifiers
are copy affordances rather than labels.
