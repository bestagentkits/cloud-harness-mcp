# Issue #406: automation providers, tooling, MCP tools, richer GitHub output

Status: in progress. Base branch: `dev`. Branch: `feat/406-automation-providers`. One PR into `dev`, no merge.

## Confirmed brief

Objective: deliver #406 on `dev`: Linear, Jira and custom webhook providers; Dashboard rule/connection
tooling; MCP automation management tools; GitHub single progress comment plus Checks.

Done means:
1. `AutomationProviderSchema` covers `github | linear | jira | custom`; `automation_connections` is rebuilt
   idempotently with a migration test, and a code-only rollback still reads the table.
2. Linear, Jira and custom each have tests for a valid signature, a bad signature, a stale timestamp or
   replay, and normalized transitions. Linear does not assume a GitHub-style `labeled` action.
3. Non-GitHub rules must pin `action.repository`; an event can never choose the repository, owner,
   workspace or a command (tested).
4. Linear/Jira outbound uses a per-connection token sealed with `SecretKeyring`; it is never returned and
   never reaches an executor (tested).
5. Dashboard: rule editor with test-event preview, connection health, replay, dead-letter view, success,
   cost and latency per provider and per rule; UI contract tests pass.
6. MCP tools to list/create/disable rules and list/get/cancel runs, principal-fenced with permission tests;
   the public ingress does not expose them.
7. GitHub: one edited progress comment per workflow; PR workflows create and update one Check Run; falls
   back to the comment when the App lacks `checks` permission (tested).
8. `docs/`, `docs-site/` and the `cloudharness` skill are updated, `plugin:sync` is byte-identical; unit,
   integration, lint and typecheck pass on the PR; isolated review clean; issue #406 labelled `done`.

Out of scope: Linear/Jira OAuth apps, JSON-pointer mapping for custom webhooks, merge or deploy, live
Linear/Jira verification (fixtures follow the official docs), approvals/HITL.

Constraints: automation agents stay read-only; the ingress forwards raw bytes and never runs an agent; no
generic endpoint executes commands; secrets live only in the runner; rules created through MCP default to
disabled; replay re-runs matching on stored normalized fields (raw payloads stay unstored).

## Phases

| Phase | Owner files | Depends on |
| --- | --- | --- |
| 1 Foundation | contracts `automations-api.ts`, `automation-schema.ts`, `automation-service.ts`, `automation-github.ts`, new `automation-providers.ts`, `webhook-ingress.ts`, existing automation tests | none |
| 2 Linear adapter | new `apps/runner/src/automation-linear.ts` + test, one registry line | 1 |
| 3 Jira adapter | new `apps/runner/src/automation-jira.ts` + test, one registry line | 1 |
| 4 Custom adapter | new `apps/runner/src/automation-custom.ts` + test, one registry line | 1 |
| 5 GitHub output | `automation-github.ts` publisher, `github-app-broker.ts` check-run ops | 1 |
| 6 Tooling | runner replay/health/metrics ops, dashboard automations UI and BFF | 1 |
| 7 MCP tools | `apps/api/src` MCP tool registration, contracts tool schemas | 1, 6 |
| 8 Docs and skill | `docs/`, `docs-site/`, `.agents/skills/cloudharness/`, plugin sync | 2-7 |

Phase 1 records the extension contract in [foundation-contract.md](foundation-contract.md).
