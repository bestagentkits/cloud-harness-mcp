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
which the dashboard and agents can read at `GET /api/v1/model-providers`.

| Provider | Chat Completions | Responses | Auth header |
| --- | --- | --- | --- |
| OpenAI | `api.openai.com/v1/chat/completions` | `api.openai.com/v1/responses` | Bearer |
| Anthropic Claude | `api.anthropic.com/v1/chat/completions` (OpenAI SDK compatibility) | Not supported | Bearer or `x-api-key` |
| OpenRouter | `openrouter.ai/api/v1/chat/completions` | `openrouter.ai/api/v1/responses` | Bearer |
| Google Gemini | `generativelanguage.googleapis.com/v1beta/openai/chat/completions` | Not supported | Bearer |
| DeepSeek | `api.deepseek.com/chat/completions` | Not supported | Bearer |
| Custom | Your HTTPS URL on port 443 (SSRF-validated) | Your HTTPS URL | Bearer or `x-api-key` |

Saving a profile with an API mode its provider does not offer, or a credential with an auth
header its provider does not accept, is refused with a message naming the supported values.

> **Gemini profiles created before this fix** were routed to a path Google does not serve and
> failed with 404. Profile revisions are immutable, so edit and save each Gemini profile once:
> the new revision uses the documented `v1beta/openai` endpoint.

### Adding a Credential
1. Navigate to **Configuration $\rightarrow$ Models** in the sidebar.
2. Click **+ Add credential**.
3. Select the provider, enter a label, and paste your API key.
4. Click **Save credential**. Keys are write-only and cannot be viewed in plaintext after submission.

### Rotating a Credential
1. Locate the credential in the **Provider Credentials** table.
2. Click **Rotate**.
3. Enter the new API key and confirm. The active version increments atomically in memory.

## Configuring Model Profiles

Model profiles define how subagents interact with LLMs:
- **Model Name:** The provider-specific model identifier (e.g. `gpt-5.2-codex`, `claude-3.7-sonnet`).
- **API Mode:** `chat-completions` (`/v1/chat/completions`) or `responses` (`/v1/responses`).
- **Token Pricing:** Input and output token pricing in USD per 1M tokens.
- **Budget Limits:** Hard limits for maximum input tokens, output tokens, and cost per agent execution.
- **Allowed Proxy Operations:** Hard ceiling on permitted file and search operations from the exact 10 safe tools (`files_list`, `files_read`, `files_write`, `files_apply_patch`, `files_delete`, `files_move`, `files_mkdir`, `grep_search`, `symbols_search`, `symbols_references`).

## Where this page lives now

The page is labelled **Models & Budgets** in the navigation and still lives at
`/dashboard/models`, so existing links keep working. It follows the shared resource-page
layout: the page heading and help come from the dashboard's page registry, the single
accented action (**Add profile**) and its secondary (**Add credential**) sit in the header
action slot, and both open dialogs rather than permanent forms under the list. Identifiers
are copy affordances rather than labels.
