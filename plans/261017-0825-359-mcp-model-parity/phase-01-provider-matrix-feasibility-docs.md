# Phase 1: Provider matrix and feasibility docs

**Depends on:** nothing. **Runs in parallel with:** phase 2, which touches no docs.

**Owner files:**
- `docs-site/reference/model-providers.md` (new)
- `docs-site/.vitepress/config.ts` (one sidebar entry under Reference, next to
  `:155-159`)

`docs-site/dashboard/models.md` is not touched. #358 phase 6 owns it until it merges;
phase 3 of this plan adds one link to it.

## Context (verified)

- Every provider row comes from the registry: `packages/contracts/src/model-provider-registry.ts:40-147`.
  It records auth modes, endpoints per API mode, the models endpoint, the catalog
  strategy, and whether the provider bills cache writes.
- Outbound hosts are limited to each provider's registry hosts. A custom provider may
  reach only its own upstream host (`apps/runner/src/model-provider-http.ts:112-136`).
- The gateway identifies itself as `cloud-harness-model-gateway`
  (`apps/model-gateway/src/upstream.ts:127-129`). It sends an optional session header
  named by `MODEL_GATEWAY_SESSION_HEADER` (`apps/model-gateway/src/config.ts:366`,
  `apps/model-gateway/src/gateway.ts:233`; documented at `docs/configuration.md:509-512`).
- Verification:
  - It is rate limited per principal and audited (`apps/runner/src/model-verification/model-connection-verifier.ts:194,234`).
  - Its checks are `authentication`, `model_access`, `protocol`, `streaming_inference`,
    and `tool_call` (`packages/contracts/src/model-verification-schemas.ts:5-7`).
  - Draft results are single-use (`apps/runner/src/model-verification/draft-verification-store.ts:65-77`).
- Catalog availability is `listed_for_credential`, `public_catalog`, or `unknown`, and
  freshness is `fresh`, `stale`, or `unavailable` (`packages/contracts/src/model-catalog-schemas.ts:54,75`).

## Requirements

### The new page `docs-site/reference/model-providers.md`

1. **Provider support and auth matrix.** One row per registry provider with:
   - the auth header modes;
   - the supported API modes;
   - the catalog source;
   - the cache-write billing assumption;
   - a link to the provider's key page.

   Do not copy endpoint URLs. Point readers to `GET /api/v1/model-providers` and, after
   phase 3, to `model_provider_list` as the live source. A "Not supported" sub-table
   covers:
   - ChatGPT plan sign-in;
   - consumer-session scraping;
   - Anthropic Messages and Google-native protocols, which the gateway does not speak.

   OpenCode Go is listed as "Custom (OpenAI-compatible) plus
   `MODEL_GATEWAY_SESSION_HEADER=x-opencode-session`" until phase 5 replaces the row.
2. **Sync and verification limitations:**
   - Catalog listings are cached with a last-good snapshot. `public_catalog` entries do
     not prove the credential can use the model.
   - Prices may be `null` (unknown, never free). The repricing review compares pinned
     prices only with cached catalog prices.
   - A connection check proves one route at one moment. It spends a few tokens, is
     rate limited, and is never charged to the spend ledger (#358 open question 5).
   - A draft result attaches only to a save with the identical route, and only once.
   - Gateway sync is asynchronous. `model_config_status` shows the last sync.
3. **Feasibility record.** Write it as user-facing verdicts with a short reason and the
   source links below. The full evidence stays in this phase file. This is a durable
   maintainer decision, so it belongs in the docs, not only in the plan.

## Feasibility record (research performed 2026-10-17)

### ChatGPT plan sign-in ("Sign in with ChatGPT" plan usage)

**Findings:**
- OpenAI publishes a preview contract for using a ChatGPT plan from third-party apps.
  It launched at DevDay 2026; see [The New Stack](https://thenewstack.io/sign-in-with-chatgpt/)
  and the [OpenAI cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).
- Scope, quoted from the [overview](https://developers.openai.com/siwc/token-sharing-open-source):
  "These docs explain ChatGPT plan usage for open-source and locally hosted apps." and
  "If you're interested in offering it in a paid or remotely hosted app, complete the
  interest form" ([form](https://openai.com/form/sign-in-with-chatgpt-interest/)).
- The cookbook says the same: plan usage is for "open-source projects, personal
  projects that run locally" and selected private apps. Paid or remotely hosted apps
  must request access first.
- Auth ([registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)):
  - dynamic client registration through `client_id=dynamic_agent_client` with an
    `ext_agent_host_id`;
  - PKCE with an **HTTP loopback redirect on `127.0.0.1`**;
  - the scopes `offline_access resource.invoke chatgpt.tokens.use.direct`;
  - **rotating refresh tokens**, with credentials stored as 0600 files.
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms):
  you complete OAuth on a local machine and copy the credential file to the VM over
  SSH. The page says: "Host-specific usage attribution and revocation of ChatGPT plan
  access for transferred sessions are not yet available."
- Inference ([models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)):
  - Responses API only, with `store: false` and `stream: true` on every request;
  - usage-limit failures arrive mid-stream as `response.failed`;
  - the [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
    rule out hosted tools.
- The help-center article
  ([Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites))
  returned HTTP 403 to automated fetch. Its content is cited only through search
  summaries.

**Verdict: do not ship an adapter in #359.** Record the reasons:
1. **Eligibility.** Cloud Harness is an internet-facing service that serves remote MCP
   clients and, in `cloudflare-access` mode, several principals. That is a "remotely
   hosted app", so OpenAI's approval through the interest form comes first. The
   self-hosted VM path describes moving a desktop session to a VM. It does not describe
   a service that brokers plan usage to remote agents.
2. **Contract fit.** The harness cannot receive a `127.0.0.1` callback. Pasting the
   redirected URL by hand is not part of the documented flow.
3. **Architecture.** Today's credential model is a static key, re-encrypted on rotate
   and pushed to the gateway in a snapshot (`apps/runner/src/model-profile-state-repository.ts:1003-1102`).
   Plan usage needs:
   - a runner-owned OAuth credential kind with atomic rotating-refresh storage;
   - a gateway re-sync at least hourly (the sample tokens have `expires_in: 3600`);
   - forced `store: false` and `stream: true` rewriting in the gateway;
   - a notional price, so caps and ledger estimates stay meaningful.
4. **Operations.** For transferred sessions there is no host attribution and no
   revocation, and the contract is still preview.

**Revisit when** OpenAI approves this deployment class, or extends self-serve
eligibility to self-hosted remote services. Then open a dedicated design issue. Filing
that follow-up issue is left to the owner, because this plan does not touch GitHub. It
would cover the OAuth credential kind, the refresh owner, and the gateway rewrite.

### OpenCode Go

**Findings ([official docs](https://opencode.ai/docs/go)):**
- OpenCode Go is a $10 or $40 monthly subscription to open coding models, used with an
  API key from the OpenCode Console. Go workspaces are single-member.
- Documented endpoints:
  - `https://opencode.ai/inference/go/openai/v1/chat/completions`;
  - `.../openai/v1/responses`;
  - `.../anthropic/v1/messages`;
  - a Google path;
  - models at `https://opencode.ai/inference/go/v1/models`.
- Usage limits are dollar allowances per model: 5-hour, weekly, and monthly.
- Third-party clients are addressed directly. The docs say "designed for OpenCode and
  other coding agents that produce similar types of requests", list validated clients
  (including Pi), and ask clients to send their own user agent and a stable
  `x-opencode-session`.
- Third-party guides cite older `/zen/go/` paths:
  [bitdoze](https://www.bitdoze.com/opencode-go-plan/) and
  [bswen](https://docs.bswen.com/blog/2026-09-04-opencode-go-models/). The official
  page wins; phase 5 re-checks it at PR time.

**Verdict: ship it as an API-key provider (phase 5).** The contract is documented, uses
an API key that fits the existing credential model, and its client requirements are
already met by the gateway: its own user agent, plus the session header filled with the
agent id. Limitations to document:
- Models served only on the Anthropic Messages or Google paths cannot be used. The
  connection check reports `unsupported_protocol`.
- OpenCode publishes per-token prices on its Go page, but a Custom provider has no
  catalog price, so pinned prices are operator overrides and every figure is an estimate.
- Plan allowances are enforced by OpenCode, not by the harness.

## Tests

None; this phase changes docs only. Run `npm run docs:build` and
`npm run docs:links` (`package.json:41,47`).

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| Vendor docs change after the record is written | M×M | Date the record, link the sources, and have phase 5 re-verify the OpenCode endpoints. |
| Matrix drifts from the registry | M×L | Link to the live endpoint instead of copying URLs. Phase 5 updates the rows with the registry change. |

## Rollback

Revert the PR.
