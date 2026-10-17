# Phase 1: Gateway cache-aware accounting and reservation review

Owner files: `apps/model-gateway/src/{budget.ts, usage-normalizer.ts (new), types.ts, upstream.ts, gateway.ts, control.ts, config.ts, lease-registry.ts, fake-provider.ts}`, `apps/model-gateway/test/{usage-accounting.test.ts (new), model-gateway.test.ts, gateway-dynamic-control.test.ts}`, `docs/system-architecture.md`, `docs-site/reference/limits.md`, `docs/troubleshooting.md`, `docs-site/troubleshooting.md`.
MCP skill / `docs/mcp-api.md`: no change, because the agent tool contract is untouched.

## Current behaviour (verified)

- `budget.ts:50` reserves one input token per request-body byte. Input is priced only at `inputMicrosPerMillionTokens`.
- `budget.ts:102-118` (`usageFromProvider`) reads only the top-level `usage` field, using `input_tokens ?? prompt_tokens` and `output_tokens ?? completion_tokens`. It reads no cache or reasoning detail, and it never reads `response.usage`. A Responses stream reports usage inside `response.completed` under `response.usage`, so every Responses request settles at the full reservation. Prove this with a failing test first.
- `budget.ts:84-100` clamps each actual component to its reservation. If the provider reports more than was reserved, the gateway under-charges silently.
- `gateway.ts:233` is the failure path. It never refunds, so a failed or cancelled request keeps its full reservation. That is correct and must be kept.
- `control.ts:137-138` and `config.ts:12` accept only input and output prices. `lease-registry.ts` `revoke`/`#prune` drop a grant without keeping what it consumed.

## Provider usage fields (normalised in the new `usage-normalizer.ts`)

| Shape | Prompt total | Cache read | Cache write | Output (includes reasoning) |
| --- | --- | --- | --- | --- |
| OpenAI chat / OpenRouter / Gemini compat | `prompt_tokens` (inclusive) | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` (OpenRouter) | `completion_tokens`; `completion_tokens_details.reasoning_tokens` |
| OpenAI Responses (top-level or `response.usage`) | `input_tokens` (inclusive) | `input_tokens_details.cached_tokens` | none | `output_tokens`; `output_tokens_details.reasoning_tokens` |
| DeepSeek | `prompt_tokens` = hit + miss | `prompt_cache_hit_tokens` (when `cached_tokens` is absent) | none | `completion_tokens` |
| Anthropic native names (custom proxies) | `input_tokens` + read + write (additive) | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` |
| Any | — | — | — | OpenRouter `usage.cost` (USD) is used as a floor |

Sources: `plans/reports/researcher-261017-0434-model-provider-endpoints.md` §Usage fields. The pi runtime parser in `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:1106-1119` treats reads and writes as included in `prompt_tokens`. Anthropic's OpenAI-compatible endpoint does not support prompt caching and always returns empty `*_tokens_details`, so it reports only plain totals.

The normalisation rules below are conservative:
- Inclusive shape: uncached = prompt − read − write. If read + write > prompt, the report is inconsistent, so switch to the additive interpretation, which costs more.
- If Anthropic cache names appear next to `prompt_tokens`, compute both interpretations and charge the larger.
- Output is max(`completion_tokens`, `total_tokens − prompt_tokens`) when `total_tokens` is present. If `reasoning_tokens` > output, the reasoning was reported separately, so charge output + reasoning.
- If the provider reports a cost, charge max(computed, ceil(cost × 1e6)).
- Negative values, non-integers, or a missing prompt or output total mean "no usage", and the request settles at its reservation.

## Requirements

1. **Pricing model** (`types.ts`, `control.ts`, `config.ts`). `GatewayProfile` gains `cacheReadMicrosPerMillionTokens`, `cacheWriteMicrosPerMillionTokens`, and `tiers` (at most 4 entries of `{minPromptTokens, input, output, cacheRead, cacheWrite}`).
   - If these fields are absent, read = input, write = input, and there are no tiers. That is exactly today's cost semantics; the runner resolves unknown prices in phase 2.
   - Validation: `minPromptTokens` must be strictly ascending, and each price must be >= the price in the tier below. A snapshot that fails validation is rejected whole and leaves the registry unchanged, keeping the staging behaviour at `control.ts:90-148`.
2. **Cost** (`budget.ts`). Pick the highest tier whose `minPromptTokens` <= the reported prompt total. Charge uncached tokens at the input price, reads at the read price, writes at the write price, and output at the output price. Each component is rounded up with the existing `costMicros` ceiling.
3. **Reservation review** (`budget.ts`). Keep one token per byte, and add a code comment explaining why.
   - Why one token per byte is safe: byte-level BPE tokens are at least one UTF-8 byte each, and per-message template tokens are smaller than the JSON framing bytes of that message.
   - Add `MEDIA_PART_RESERVE_TOKENS = 8192` for each image, file, or audio content part. Data URLs need it too: a tiny image can cost more tokens than its bytes.
   - Price the reserved input at max(input, cacheWrite) of the tier that applies to the estimated token count. Because bytes >= tokens and tier prices never fall, the reserved tier is at least the actual tier.
   - On `/v1/responses`, reject `previous_response_id`, `conversation`, and object-valued `prompt` with `400 invalid_model_request`. The server-side context they pull in cannot be bounded. The pi runtime already sends `store: false` (`node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js:218`).
4. **Reconcile** (`budget.ts`, `gateway.ts`). `charged` is the actual usage, or the reservation when usage is missing. Refund max(0, reserved − charged) per component, so a refund never exceeds the reservation. Any overrun (charged > reserved) is deducted from the lease's remaining budget, floored at 0. It is added to `lease.overrunCostMicros` and logged as `provider usage exceeded reservation` with ids only.
5. **Settlement** (`lease-registry.ts`, `control.ts`, `gateway.ts`).
   - Each grant records its initial caps and running counters: prompt, read, write, output, reasoning, requests, and requests without usage.
   - When a grant is revoked or expires, the registry keeps a frozen settlement keyed by `leaseId`. Retention matches the 24h horizon of `#used`, and the settlement counts toward `maxEntries`.
   - The `revoke` response additively gains `gatewayBootId` and `settlement`. Settlement cost is initialCost − remainingCost + overrun, so failed and in-flight requests count at their reservation. `revoke` already drains in-flight requests (`gateway.ts:147-156`) before it returns.
   - `issue` additively returns `gatewayBootId`.
6. `upstream.ts` keeps the output-limit abort at `:167`. The limit is compared against output that includes reasoning.

## Tests (write the failing ones first)

- `usage-accounting.test.ts` (unit) covers:
  - every row of the table above;
  - the ambiguous mixed shape and inconsistent read + write;
  - missing or malformed usage, which settles at the reservation;
  - reasoning reported separately from output;
  - the OpenRouter cost floor;
  - tier selection at, below, and above the threshold, and tier validation;
  - overrun accounting, and a refund that never exceeds the reservation;
  - the media-part surcharge, the stateful Responses fields being refused, and reserving at the cache-write price.
- `model-gateway.test.ts` (end to end through `fake-provider.ts` over TLS) covers:
  - an SSE stream whose usage is in the final chunk and split across TCP chunks;
  - a Responses `response.completed` event with nested usage;
  - a stream that ends without usage;
  - two concurrent requests on one lease whose summed reservation never exceeds the cap;
  - `revoke` returning a settlement that includes a cancelled in-flight request at its reservation;
  - a settlement read after expiry.
- `gateway-dynamic-control.test.ts` covers a snapshot carrying cache and tier prices, and an invalid tier snapshot that is rejected and leaves the registry unchanged.

Run with `npm test -w @cloud-harness/model-gateway`, then `npm run verify`.

## Docs

- `docs/system-architecture.md` gateway section: accounting rules, why the reservation is conservative, settlement on revoke.
- `docs-site/reference/limits.md`: reservation rule and media surcharge.
- Both troubleshooting files: the 400 for stateful Responses fields.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| Reserving at the write price shrinks affordable output while a request is in flight | M×L | Refunded on reconcile. The runner sends write = input for providers that never bill writes (phase 2). |
| Refusing stateful fields breaks a runtime | L×M | pi already sends `store:false`; the error names the field. |
| A provider double-reports cache fields | L×M | Taking the larger interpretation can over-charge but never under-charge. |

## Rollback

Revert the PR. The gateway is RAM-only, and the runner ignores the additive control fields because `agent-gateway-control.ts:99-104` parses only the fields it knows.
