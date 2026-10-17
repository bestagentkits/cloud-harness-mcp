# MCP Events subscriptions and signed delivery (#327)

Status: in progress · Branch: `claude/determined-gates-w2gg5w` → `dev`

## Outcome
ChatGPT Work (MCP `2026-07-28`) can `events/list`, `events/subscribe`,
`events/unsubscribe` four Cloud Harness terminal-state events and receives
Standard Webhooks–signed callbacks, at least once, from the API egress lane.

## Decisions
- Protocol: MCP Events design sketch, webhook mode only (what ChatGPT supports).
  Error codes follow the revision ChatGPT documents (`-32011`…`-32015`), kept in
  one contracts constant so a renumber to `-32023`…`-32027` is one change.
- Events: `cloudharness.task.completed` (SUCCEEDED), `cloudharness.task.failed`
  (FAILED, CANCELLED, BLOCKED), `cloudharness.agent.settled` (agent SUCCEEDED
  terminal record, never turn end), `cloudharness.agent.failed` (FAILED,
  CANCELLED, TIMED_OUT, LIMIT_EXCEEDED, INTERRUPTED with `outcomeUnknown`).
  Payloads carry ids, status, codes, timestamps only — never output or messages.
- Storage: runner state DB (schema v13). Subscriptions keyed by
  `(owner_id, url, name, canonical arguments)`; secrets sealed with the secret
  keyring. The outbox row and per-subscription delivery rows are inserted in the
  same SQLite statement path as the generation-guarded terminal transition.
- Delivery: API worker claims leased deliveries from the runner over the service
  channel, signs, and POSTs through the existing SSRF policy (per-request
  resolve, pinned socket, no redirects, bounded time/body). The runner never
  dials callbacks.
- Verification: signed `verification` challenge before first activation per
  `(principal, url)`; cached 24 h.
- TTL: default and max grant 24 h, floor 60 s; `ttlMs: null` gets a finite grant.
- Revocation: subscriptions created through a managed API key stop when the key
  is revoked or expires; OAuth-lane subscriptions lapse at TTL; the dashboard can
  revoke any of the principal's subscriptions.
- Retention: delivered/abandoned rows and outbox rows purged after 7 days;
  expired subscriptions after 7 days.

## Acceptance
See issue #327. Mock-callback E2E tests; live ChatGPT verification recorded
separately.
