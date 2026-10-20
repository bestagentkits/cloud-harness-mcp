# feat(dashboard): P5 CX/AX polish, command palette, Dewee webchat and page actions (#458)

Parent: #458 · Depends on P3/P4

## Scope
- CX: onboarding/empty-state guidance, next-action hints, copy that says what failed / is retryable / needs approval / is irreversible; micro-interaction feedback (120–240 ms, reduced-motion aware); route lazy load + hover/focus prefetch; reload restores URL state, non-secret drafts, wizard step, tabs, scroll.
- AX: backend-confirmed agent/task/workspace status, trace/log/approval deep links (reuse #416/#394/#393 surfaces).
- Command palette completion (pages, recent workspaces, actions).
- Dewee webchat: widget bundled from npm (no CDN); BFF handler `/dashboard/api/v1/dewee/*` behind Access + session + CSRF + per-principal rate limit + body limit; gateway token server-side only (`DEWEE_WEBCHAT_SECRET` generated on host, never printed); agent `cloud-harness-operator` configured with `dewee` commands and a Cloud Harness system prompt.
- Typed dashboard action registry exposed as client tools: navigate, read visible non-secret state, set filters, open wizard, prepare mutation. Sensitive/destructive mutations require an explicit user click; the agent never receives secrets or API keys. The registry builds each request body from a typed schema and never forwards a raw agent payload; the confirmation dialog renders exactly the body that will be sent. `getPageContext` returns non-secret summary state only (no file content, terminal output, diffs or log bodies).
- Prerequisite (before or within P5): fix BFF finding F1 (body `workspaceId`/id overriding the path id) per the parity matrix.
- Dewee agent attached to Cloud Harness MCP via the API-key lane with a full-scope managed key (owner opt-in 2026-10-20); record in `docs/security-model.md`, including that visible page data and MCP reads (file content, terminal output) may flow to the Dewee gateway/LLM and the prompt-injection risk; control = key revocation.

## Gates
- E2E with the gateway stub per dewee-webchat `docs/http-contract.md`: agent navigates and prepares a mutation; mutation blocked until the user confirms; no secret in tool results.
- BFF tests for the Dewee route: no session → 401, missing CSRF → 403, rate limit → 429, token never in response/logs.
- axe WCAG 2.2 AA clean on key flows; keyboard-only flows.

## Dependencies
P3, P4; dewee-webchat client-tools release (separate repo, PR + npm release + tag).

## Rollback
Flag `legacy`; Dewee route can be disabled by unsetting its config; revoke the MCP key.
