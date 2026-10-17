# Issue #399 — webhook-triggered Pi automations (P0 + P1 MVP)

Status: in progress · Base: `dev` · Branch: `claude/determined-gates-03019p`

## Outcome
An owner opts in (`AUTOMATIONS_ENABLED=true`), creates a GitHub webhook connection and an
exact-match rule (repo + `issues`/`pull_request` + `labeled` + label). A signed `labeled`
delivery is verified on raw bytes, durably persisted and deduplicated, matched, and admitted
as exactly one logical workflow that opens a `network-none` workspace on the rule's repository,
spawns one bounded Pi agent through the existing `agent_spawn` path, tracks it to a terminal
state, optionally posts one GitHub comment through the existing broker, emits an MCP Event and
closes the workspace. Dashboard shows connections, rules and runs.

## Constraints
- Feature defaults OFF; unconfigured events are inert.
- Webhook secrets stay in the runner keyring; the API never sees them; it forwards raw bytes.
- Webhook text is untrusted data placed inside a bounded, delimited prompt section; it never
  selects workspace, owner, profile, tools, budget or repository.
- Additive schema (no version bump), like `model-spend-ledger`.
- Reuse WorkspaceService.execute for workspace_open / agent_spawn / agent_status /
  github_action / workspace_close so every existing guard applies.

## Non-goals (split into follow-up issues)
- P2: HITL approvals, resume, controlled coding capability broker.
- P3: Linear / Jira / custom providers, MCP tool exposure of automation management.

## Phases
1. Contracts: `packages/contracts/src/automations-api.ts`, config flags, MCP event names.
2. Runner: `apps/runner/src/automation-*.ts` (schema, ingest/verify, matcher, workflow engine,
   GitHub outcome publisher), `/v1/internal/automations`, tests.
3. API: public `POST /integrations/webhooks/github/:connectionId`, dashboard BFF routes, nginx.
4. Dashboard UI: Automations page (connections, rules, runs).
5. Docs: docs/ + docs-site/ + skill guidance.

## Acceptance
See issue #399 acceptance criteria 1–3, 5–7 (4 = HITL is P2).
