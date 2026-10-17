# Model provider endpoints, auth, catalogs, usage (research 2026-10-17)

Sanitized summary for #353 phases. Probes were unauthenticated bad-key requests.

| Provider | Chat Completions | Responses | Auth | Models endpoint | Bad-key status |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `https://api.openai.com/v1/responses` | Bearer | `GET /v1/models` → `{data:[{id, created, owned_by}]}`, no context/pricing | 401 |
| Anthropic | `https://api.anthropic.com/v1/chat/completions` (compat; "not production-ready", no cached-token details) | none (404) | Bearer on compat | `GET /v1/models` needs `x-api-key` + `anthropic-version: 2023-06-01`; paginated `after_id`/`limit`≤1000; `max_input_tokens`, `max_tokens`, `display_name` | 401 |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `https://openrouter.ai/api/v1/responses` (stateless) | Bearer | `GET /api/v1/models` public, ~469 models, `offset`/`limit`; key check `GET /api/v1/key` | 401; 402 credits; 403 budget; 429 rate |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | undocumented → unsupported | Bearer | `GET /v1beta/openai/models` (ids only); native `/v1beta/models` has token limits | **400** INVALID_ARGUMENT (also 403) |
| DeepSeek | `https://api.deepseek.com/chat/completions` | undocumented → unsupported | Bearer | `GET /models` → `context_window`, `max_output_tokens` | 401; 402 balance; 429 |
| OpenCode Go | `https://opencode.ai/inference/go/openai/v1/chat/completions` (per-model path) | `…/openai/v1/responses` for some models | Bearer | public `GET /inference/go/v1/models` (cannot verify a key) | 401; missing `x-opencode-session` → 400 before auth |

## Usage fields

- OpenAI chat: `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`; Responses: `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`.
- OpenRouter: usage always in last chunk (`include_usage` no-op), plus `cost`, `prompt_tokens_details.cache_write_tokens`.
- DeepSeek: `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, plus OpenAI-style details.
- Gemini compat and OpenCode Go: undocumented; needs a live key.

## OpenRouter pricing

Decimal strings, USD per token. Keys observed: `prompt`, `completion`, `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, `web_search`, `internal_reasoning`, `image`, `audio`, `input_audio_cache`, `image_output`, `audio_output`, `overrides[]` (conditional, e.g. `min_prompt_tokens`). `request` documented but unused. Treat as an open map; skip overrides with unknown conditions. Sample: `plans/261017-0429-353-provider-first-model-setup/openrouter-models-sample.json`.

## Policy decisions

- **ChatGPT plan sign-in**: official OAuth (PKCE, loopback redirect, Responses-only) is self-serve only for open-source locally hosted apps; remotely hosted apps need OpenAI approval via interest form. Not shipped.
- **OpenCode Go**: third-party coding agents permitted with own User-Agent and a stable `x-opencode-session`; endpoint is per model and the session header is mandatory. Needs per-provider session header and per-model endpoint support in the gateway; tracked in #359.
