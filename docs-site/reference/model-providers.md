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
dashboard sessions read it live at `GET /api/v1/model-providers`. An MCP tool that lists
providers (`model_provider_list`) is planned but not available yet.

| Provider | Auth header | API modes | Catalog source | Cache-write billing assumed | API keys |
| --- | --- | --- | --- | --- | --- |
| OpenAI | Bearer | Chat Completions, Responses | Provider's models endpoint, with your key | No | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic Claude | Bearer or `x-api-key` | Chat Completions (OpenAI SDK compatibility) | Provider's models endpoint, with your key | No | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenRouter | Bearer | Chat Completions, Responses | OpenRouter's public catalog | Yes | [openrouter.ai](https://openrouter.ai/settings/keys) |
| Google Gemini | Bearer | Chat Completions (OpenAI-compatible endpoint) | Provider's models endpoint, with your key | No | [aistudio.google.com](https://aistudio.google.com/apikey) |
| DeepSeek | Bearer | Chat Completions | Provider's models endpoint, with your key | No | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| Custom (OpenAI-compatible) | Bearer or `x-api-key` | Chat Completions or Responses, at the one HTTPS URL you enter | None: you enter the model ID | Yes | Your provider's console |
| OpenCode Go | Custom (OpenAI-compatible) plus `MODEL_GATEWAY_SESSION_HEADER=x-opencode-session` | See [OpenCode Go](#opencode-go) | None: you enter the model ID | Yes (as Custom) | [opencode.ai](https://opencode.ai/docs/go) |

What the columns mean:

- **Cache-write billing assumed** only matters when a profile leaves its cache-write price
  unknown. The gateway then charges cache writes at twice the input price for a provider
  that may bill them, and at the input price otherwise. The rule is owned by
  [`model-pricing.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/packages/contracts/src/model-pricing.ts).
- **Outbound hosts.** A key for a registry provider is only ever sent to that provider's own
  registry hosts. A Custom key is only sent to the host of its own upstream URL. The check
  is owned by
  [`apps/runner/src/model-provider-http.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/apps/runner/src/model-provider-http.ts).

### Not supported

| Option | Why |
| --- | --- |
| ChatGPT plan sign-in ("Sign in with ChatGPT" plan usage) | Not offered to remotely hosted apps without OpenAI's approval. See the [feasibility record](#chatgpt-plan-sign-in). |
| Consumer chat sessions (cookies or scraped web sessions) | Not a provider API contract. The harness accepts only provider API keys. |
| Anthropic Messages and Google-native protocols | The gateway speaks only the OpenAI Chat Completions and Responses protocols. Use a provider's OpenAI-compatible endpoint instead. |

## OpenCode Go

[OpenCode Go](https://opencode.ai/docs/go) works today as a **Custom (OpenAI-compatible)**
provider:

1. Set `MODEL_GATEWAY_SESSION_HEADER=x-opencode-session` for the instance (see
   [configuration](https://github.com/bestagentkits/cloud-harness-mcp/blob/dev/docs/configuration.md#model-gateway-provider-overrides))
   and restart the gateway. OpenCode Go rejects requests without this header.
2. Add a Custom credential with your OpenCode Console API key and the Bearer auth mode.
3. Create a profile with the OpenCode Go Chat Completions or Responses URL from its docs,
   the matching API mode, and the model ID. OpenCode lists which models are served on
   which path.

Limitations:

- The session header is instance-wide. When set, the gateway sends it, filled with the
  calling agent's ID, on every upstream request to every provider.
- The connection check runs from the runner, which does not send the session header, so
  OpenCode Go may reject it and the profile shows **Not verified**. That status does not
  block activation or spawning; a short subagent run is the real test.
- Models served only on OpenCode's Anthropic Messages or Google paths cannot be used.
- OpenCode does not publish per-token prices for Go, so any prices you enter are your own
  estimates. Plan allowances are enforced by OpenCode, not by the harness.

A dedicated OpenCode Go provider entry is planned. Until it ships, use the steps above.

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
  moment. The inference and tool checks spend a few tokens on your provider account and
  are rate limited per principal. They call the provider from the runner, not through the
  Model Gateway, so they are not counted against any agent's budget caps.
- **Draft results.** A check run in the profile wizard attaches only to a save with the
  identical route, by the same principal, and only once. Any other save succeeds but shows
  **Not verified**.
- **Gateway sync.** Saving a profile or credential pushes a new snapshot to the gateway,
  but the save succeeds even if that push fails. The dashboard's model status
  (`GET /api/v1/agent-model-config-status`) reports whether the gateway is in sync and when
  it last synced.

The full behaviour of the catalog, checks, and pricing review is described in
[Models & Budgets](/dashboard/models).

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

### OpenCode Go

**Verdict: supported through a Custom provider today.** Source reviewed 2026-10-17:
[OpenCode Go docs](https://opencode.ai/docs/go).

OpenCode Go uses an API key, which fits the existing credential model, and documents
OpenAI-compatible Chat Completions and Responses endpoints. Its docs address third-party
coding agents directly and ask them to send their own user agent and a stable
`x-opencode-session`. The gateway identifies itself as `cloud-harness-model-gateway` and
fills the session header when it is configured. The limits are listed under
[OpenCode Go](#opencode-go) above.
