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
- **Conditional pricing.** `hasConditionalPricing` marks a price that also changes under a
  condition the tiers cannot express: an override with any other condition, more tiers than
  a revision can hold, two overrides for one threshold, or a tier that would break the tier
  rules once unknown cache prices are resolved for the selected provider. Such overrides are
  left out, so the listed prices understate some requests.

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
    catalog model its prices came from. The runner looks that model up in its own cached
    catalog, without a network call. When the submitted input, output, cache read, cache
    write, and tier prices all equal the cached catalog price, the catalog's provenance is
    copied with `isOverride: false`: confidence `exact` when an OpenRouter profile routes to
    that very model, `estimate` otherwise (a direct vendor, or another OpenRouter model).
    For a direct vendor the reference must name one of that vendor's models.
  - Pricing that differs in any price or tier is your override: `source: "user"`,
    `isOverride: true`, confidence `unknown`, with the referenced catalog model and its
    retrieval time kept for context.
  - A save without a reference, or with one the cached catalog does not list, is recorded
    as your override with no source model. Revisions saved before provenance existed read
    back the same way.

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
cached catalog price for its `sourceModelId`, or, for a revision without one, for its model
ID matched the way the catalog search matches it. The schema is `ModelPricingReviewSchema` in
[`model-profile-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-profile-schemas.ts).

- `repriced`: an input, output, cache read, cache write, or tier price differs from the
  catalog by at least `REPRICING_WARNING_PERCENT` (10%, in
  [`model-catalog-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-catalog-schemas.ts))
  in either direction; a pinned price of zero now has a catalog price; a tier exists on
  only one side; or the catalog has conditional pricing. A rise means cost estimates and
  caps are understated, a fall means they are overstated. A cache price is compared only
  when both sides state it, because an unknown pinned cache price is charged at the
  conservative default below. `changes` lists each difference with the pinned price, the
  catalog price, and the signed percentage.
- `current`: nothing differs by that much.
- `unknown`: the runner has no cached catalog price for the model, for example before the
  catalog was first searched, for a Custom provider, or for a model the catalog does not
  list.

`isOverride` repeats the revision's provenance: for your own prices the difference is
information, not a sign that the price is stale. Listing never makes a network call: the
review reads the last cached catalog, kept across restarts, whatever its age. It is computed
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
   `catalogPriceRef` to its catalog model; once you edit a price, only the input and output
   prices you typed are sent, as your override. Choose a permission preset here. **Advanced** holds the profile ID (derived
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
**Delete**. When the catalog now lists a different price for the model than the profile
saved, or the catalog price could not be refreshed, a pricing note appears next to the
price: edit the profile to take the new price. The comparison is advisory and is skipped
when the catalog cannot be reached.

## Where this page lives now

The page is labelled **Models & Budgets** in the navigation and still lives at
`/dashboard/models`, so existing links keep working. It follows the shared resource-page
layout: the page heading and help come from the dashboard's page registry, the single
accented action (**Add profile**) and its secondary (**Add credential**) sit in the header
action slot, and both open dialogs rather than permanent forms under the list. Identifiers
are copy affordances rather than labels.
