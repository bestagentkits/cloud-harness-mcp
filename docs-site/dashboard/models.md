# Subagent Models & Provider Credentials

The **Subagent Models** dashboard (`/dashboard/models`) allows authenticated operators to manage LLM provider credentials, model routing profiles, token pricing, budget limits, and safe tool permissions for coding subagents (`agent_*` tools).

## Architecture & Security Boundary

- **Zero Credential Exposure:** Provider API keys are write-only, encrypted at rest using AES-256-GCM via `SecretKeyring`, and projected dynamically into Model Gateway RAM. Provider secrets are never written to workspace directories or injected into subagent containers.
- **Dynamic Hot Reload:** Changes to model profiles and credentials take effect immediately without requiring service restarts or container redeployments.
- **Lease Pinning:** Subagents running with an active capability lease remain bound to their exact immutable profile revision. When rotating a credential, in-flight requests safely complete with the prior key while subsequent requests seamlessly use the new key.

## Managing Provider Credentials

Operators can configure API keys for multiple providers:
- **OpenAI:** Direct OpenAI API integration (`api.openai.com`).
- **Anthropic:** Anthropic Claude via OpenAI-compatible endpoints.
- **OpenRouter:** Routing through OpenRouter (`openrouter.ai`).
- **Google Gemini:** Google AI studio via OpenAI-compatible endpoints.
- **Custom:** Self-hosted or enterprise OpenAI-compatible endpoints (strictly validated for HTTPS on port 443 with SSRF protection).

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
