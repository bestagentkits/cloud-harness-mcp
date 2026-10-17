---
title: Model Providers & Feasibility
description: Which model providers subagents can use, how each authenticates, the limits of catalog sync and connection checks, and why some providers are not supported.
---

# Model Providers & Feasibility

This page explains which providers the Model Gateway can route `agent_*` subagents to, what
the harness can and cannot prove about a provider, and why some popular options are not
supported. To add keys and build profiles, see [Models & Budgets](/dashboard/models).

## Supported providers

The provider registry
([`packages/contracts/src/model-provider-registry.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-provider-registry.ts))
is the only source of truth for endpoints, auth modes, and API modes. Authenticated
dashboard sessions read it live at `GET /api/v1/model-providers`, and MCP clients read the
same list, with their own key metadata, through `model_provider_list`.

| Provider | Auth header | API modes | Catalog source | Cache-write billing assumed | API keys |
| --- | --- | --- | --- | --- | --- |
| OpenAI | Bearer | Chat Completions, Responses | Provider's models endpoint, with your key | No | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic Claude | Bearer or `x-api-key` | Chat Completions (OpenAI SDK compatibility) | Provider's models endpoint, with your key | No | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenRouter | Bearer | Chat Completions, Responses | OpenRouter's public catalog | Yes | [openrouter.ai](https://openrouter.ai/settings/keys) |
| Google Gemini | Bearer | Chat Completions (OpenAI-compatible endpoint) | Provider's models endpoint, with your key | No | [aistudio.google.com](https://aistudio.google.com/apikey) |
| DeepSeek | Bearer | Chat Completions | Provider's models endpoint, with your key | No | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| OpenCode Go | Bearer | Chat Completions, Responses (OpenAI-compatible paths) | Provider's models endpoint, with your key | Yes | [opencode.ai/console](https://opencode.ai/console) |
| Custom (OpenAI-compatible) | Bearer or `x-api-key` | Chat Completions or Responses, at the one HTTPS URL you enter | None: you enter the model ID | Yes | Your provider's console |

OpenCode asks clients to send a session header, and the harness always sends it for OpenCode
Go; see [OpenCode Go](#opencode-go).

What the columns mean:

- **Cache-write billing assumed** only matters when a profile leaves its cache-write price
  unknown. The gateway then charges cache writes at twice the input price for a provider
  that may bill them, and at the input price otherwise. The rule is owned by
  [`model-pricing.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-pricing.ts).
- **Outbound hosts.** A key for a registry provider is only ever sent to that provider's own
  registry hosts. A Custom key is sent only to the host of the upstream URL on the profile
  or draft check that uses it, so enter only upstreams you trust with that key. The check
  is owned by
  [`apps/runner/src/model-provider-http.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/apps/runner/src/model-provider-http.ts).

### Not supported

| Option | Why |
| --- | --- |
| ChatGPT plan sign-in ("Sign in with ChatGPT" plan usage) | Not offered to remotely hosted apps without OpenAI's approval. See the [feasibility record](#chatgpt-plan-sign-in). |
| Consumer chat sessions (cookies or scraped web sessions) | Not a provider API contract. The harness accepts only provider API keys. |
| Anthropic Messages and Google-native protocols | The gateway speaks only the OpenAI Chat Completions and Responses protocols. Use a provider's OpenAI-compatible endpoint instead. |

## OpenCode Go

[OpenCode Go](https://opencode.ai/docs/go) is a registry provider. Add an **OpenCode Go**
credential with your API key from the [OpenCode Console](https://opencode.ai/console), then
create a profile with a model from its catalog and the Chat Completions or Responses API
mode. OpenCode lists which models are served on which path.

OpenCode asks clients to send their own user agent and a stable session ID in
`x-opencode-session`, so it can optimize routing and prompt caching. The harness always does
both for this provider, without any instance setting:

- the gateway identifies itself as `cloud-harness-model-gateway` and sends
  `x-opencode-session` filled with the calling agent's ID;
- the connection check and the catalog listing send the same header with a new random ID
  for each call.

If `MODEL_GATEWAY_SESSION_HEADER` is also set, the provider's own header still wins for
OpenCode Go, and the instance-wide header goes to every other provider. A Custom route to
OpenCode still works when that variable is set to `x-opencode-session`, but the OpenCode Go
provider is the simpler choice.

Limitations:

- Only the OpenAI Chat Completions and Responses paths are used. A model that OpenCode
  serves only on its Anthropic Messages or Google paths fails the connection check with
  `unsupported_protocol`.
- OpenCode publishes per-token prices (input, output, cached read, cached write) on its Go
  page, but offers no price API to sync, and OpenRouter does not price the subscription. The
  catalog shows these models with unknown prices, so enter the prices on the profile
  yourself; the profile marks them as an override, and every spend figure is an estimate.
  An unknown cache-write price is charged at twice the input price.
- Over MCP, override prices on a new route always need owner approval
  (`price_unverified_for_new_route`). Like every MCP-created profile, an OpenCode Go profile
  created over MCP needs activation in the Dashboard, and an MCP update that changes its
  model or credential must be made in the Dashboard instead.
- OpenCode enforces the plan allowances (5-hour, weekly, and monthly limits); the harness
  does not mirror them. A request over a plan limit fails with the provider's error.

## Sync and verification limits

- **Catalog.** Listings are cached, and the last good copy is served while a source is
  failing (`stale`). A model with availability `public_catalog` comes from a public list
  and does not prove your key can call it; only `listed_for_credential` was returned for
  your key. The states are defined in
  [`model-catalog-schemas.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-catalog-schemas.ts).
- **Prices.** A price may be `null`, which means unknown, never free. The repricing review
  compares a profile's pinned prices only with the cached catalog price; it never fetches
  a fresh one. A Custom provider has no catalog, so its review is always `unknown`.
- **Connection checks** prove one route (credential, model, API mode, upstream) at one
  moment. Every check run is rate limited per principal, and the inference and tool checks
  also spend a few tokens on your provider account. They call the provider from the runner, not through the
  Model Gateway, so they are not counted against any agent's budget caps.
- **Draft results.** A check run in the profile wizard attaches only to the next save by
  the same principal, within a short expiry, and only when the route is identical. That
  first save uses it up whether or not it matched; any other save succeeds but shows
  **Not verified**.
- **Gateway sync.** Saving a profile or credential pushes a new snapshot to the gateway,
  but the save succeeds even if that push fails. Each snapshot replaces what the gateway
  held, so after the next successful push a deleted credential's key is dropped from the
  gateway's registry (a request already in flight finishes with the key it started with)
  and a disabled or deleted profile no longer routes. The revision an agent was spawned
  on, and the credential it needs, stay until that agent ends, even when the profile is
  edited while the spawn is in progress. Spawning a subagent pushes again when the gateway
  restarted or lost its profiles, and fails with `UNAVAILABLE` if the gateway is
  unreachable. The launch checks the gateway once more before it issues the agent's
  lease; if the gateway is unreachable by then, the spawn was already accepted, so the
  agent is cancelled instead and ends `FAILED` once the gateway can confirm its cleanup.
  The dashboard's model status
  (`GET /api/v1/agent-model-config-status`) reports whether the gateway answered and when
  the runner last attempted a push.

The full behaviour of the catalog, checks, and pricing review is described in
[Models & Budgets](/dashboard/models).

## API and MCP examples

An MCP client can prepare a profile end to end, but the owner keeps the last word. Keys are
added only on the Dashboard; no tool creates, reads, or rotates one. A profile saved over MCP
starts **Disabled**, so the owner activates it on the [Models page](/dashboard/models) before
`agent_spawn` can use it. Activation, disabling, deletion, and spend policies have no MCP
tool.

| Step | Dashboard API | MCP tool |
| --- | --- | --- |
| List providers and connected keys | `GET /api/v1/model-providers`, `GET /api/v1/provider-credentials` | `model_provider_list` |
| Find a model and its catalog price | `GET /api/v1/model-catalog` | `model_catalog_search` |
| Check a route before saving | `POST /api/v1/model-connection/verify` | `model_connection_verify` |
| Dry-run a save | `POST /api/v1/agent-model-profiles/validate` | `model_profile_validate` |
| Save a profile | `POST` / `PATCH /api/v1/agent-model-profiles` | `model_profile_create` (Disabled), `model_profile_update` |
| Activate it | `POST /api/v1/agent-model-profiles/:id/activate` | none: the owner activates it |
| Read estimated spend | `GET /api/v1/model-spend` | `model_spend_summary` (read-only) |

A typical MCP flow, with a credential the owner already added:

```json
{ "tool": "model_catalog_search", "arguments": { "provider": "openrouter", "query": "sonnet" } }
{ "tool": "model_connection_verify", "arguments": { "credentialId": "cred_…", "model": "anthropic/claude-sonnet-4.5" } }
{ "tool": "model_profile_create", "arguments": {
  "idempotencyKey": "create-reviewer-profile-1",
  "profileId": "reviewer", "displayName": "Reviewer", "credentialId": "cred_…",
  "model": "anthropic/claude-sonnet-4.5", "apiMode": "chat-completions",
  "catalogPriceRef": { "sourceModelId": "anthropic/claude-sonnet-4.5" },
  "pricing": { "inputMicrosPerMillionTokens": 3000000, "outputMicrosPerMillionTokens": 15000000 },
  "limits": { "maxInputTokens": 200000, "maxOutputTokens": 16000, "maxCostMicros": 2000000 },
  "maxProxyOperations": ["files_read", "grep_search"],
  "verificationRef": "…from the check…"
} }
```

What an MCP save cannot do on its own:

- **Escalations need the owner.** `model_profile_update` refuses, with
  `OWNER_APPROVAL_REQUIRED`, a move to another credential, a raised token or cost limit, a
  lower price that is not catalog-verified, override prices carried to another model or
  credential, and a wider proxy operation list, whether the profile is active or disabled.
  Run `model_profile_validate` first: its `escalations` list names exactly what a save would
  refuse. The owner makes those changes on the Dashboard.
- **A create is reviewed at activation.** A new profile has nothing to compare with, so only
  an unbound Custom URL refuses a create. It is saved disabled, and **Activate** on the
  Dashboard approves the whole revision the client wrote, so review its limits, prices, and
  proxy operations before activating it.
- **Custom upstream URLs stay bound.** Over MCP, a create, an update, or a draft check may
  send a Custom key only to an upstream URL that one of the owner's profiles on that
  credential already uses, including a URL an older revision used; a URL stays bound until
  its profile is deleted. A new URL is refused with `OWNER_APPROVAL_REQUIRED`, and nothing
  is sent to it.
- **Retries are safe.** A create or update needs an `idempotencyKey`. The same key with the
  same input replays the first result for 24 hours; with other input it returns `CONFLICT`.
  An update also needs the `expectedGeneration` from `model_profile_list`.

Every refusal is recorded in the audit log with the actor `mcp`. The full contracts are in
the [tools reference](/reference/tools#models-and-spend).

## Feasibility record

These are maintainer decisions about providers that users ask for. Vendor terms change, so
each verdict names the sources it was based on and when they were reviewed.

### ChatGPT plan sign-in

**Verdict: not supported.** Sources reviewed 2026-10-17:
[Sign in with ChatGPT overview](https://developers.openai.com/siwc/token-sharing-open-source),
[registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms),
[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference),
[accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
and the [OpenAI cookbook article](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

Reasons:

1. **Eligibility.** OpenAI's preview covers open-source and locally hosted apps. A paid or
   remotely hosted app must first apply through OpenAI's
   [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/). Cloud Harness is
   an internet-facing service for remote MCP clients, so it is a remotely hosted app. The
   self-hosted VM path moves one person's desktop sign-in to a VM; it does not cover a
   service that brokers plan usage to remote agents.
2. **Sign-in flow.** Sign-in redirects to an HTTP loopback address on `127.0.0.1`, which a
   remote harness cannot receive.
3. **Credential model.** The harness stores static API keys. Plan usage needs rotating
   OAuth refresh tokens, a gateway refresh at least hourly, forced `store: false` and
   `stream: true` on every Responses request, and a notional price so budget caps stay
   meaningful.
4. **Operations.** For transferred sessions OpenAI offers no per-host usage attribution or
   revocation yet, and the contract is still a preview.

**Revisit when** OpenAI approves this kind of deployment, or opens self-serve eligibility to
self-hosted remote services. That would need its own design for an OAuth credential kind,
token refresh, and gateway request rewriting.

### OpenCode Go subscription

**Verdict: supported as a registry provider.** Source reviewed 2026-10-17:
[OpenCode Go docs](https://opencode.ai/docs/go).

OpenCode Go uses an API key, which fits the existing credential model, and documents
OpenAI-compatible Chat Completions and Responses endpoints under
`https://opencode.ai/inference/go/openai/v1/` and a models list at
`https://opencode.ai/inference/go/v1/models`. Its docs address third-party coding agents
directly and ask them to send their own user agent and a stable `x-opencode-session`. The
registry records that header for the provider, so the gateway and the connection check send
it without an instance setting. The limits are listed under [OpenCode Go](#opencode-go)
above.
