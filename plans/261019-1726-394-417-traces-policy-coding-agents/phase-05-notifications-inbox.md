# Phase 05 (PR5): Notification inbox on the existing outbox, with failure injection (#417 D, D5)

Branch: `feat/417-notifications` from `dev` after PR2 (and PR1) merge. Target `dev`.
Effort about 20h. Wave W2. It can be built in parallel with PR3 and PR4. It merges after PR4 and rebases to
pick up the coding deep-link fields (PR URL and trace id) on automation runs.

## Context

- The transactional outbox is `apps/runner/src/event-outbox.ts`: `withEventSavepoint`;
  `recordEvent` (:65) writes nothing when no subscription matches; emitters are at :96, :129 and :153.
  `emitAutomationTerminalEvent` is called inside `automation-service.ts` `finish()` (:1032).
- MCP Events: `MCP_EVENT_NAMES` (six names) in `packages/contracts/src/events-api.ts`,
  `McpEventService` (claim/report) in `apps/runner/src/mcp-event-service.ts`, and webhook
  delivery in `apps/api/src/events/event-delivery-worker.ts`.
- Automation GitHub results are already tracked by `publish_state`.

## Design

- `recordEvent` returns without writing when no subscription matches
  (`apps/runner/src/event-outbox.ts:65-88`), so the outbox alone cannot back an inbox. The
  inbox therefore has its own `notifications` table, written whether or not subscribers exist.
- A notification is a row written in the same savepoint as the transition, through a new
  `emitNotification` called by the existing emitters. Hooking only `event-outbox.ts` keeps this
  PR out of `automation-service.ts`.
- Logical identity: `dedupe_key = <principal>:<subject>:<transition>` with a UNIQUE
  constraint. Duplicate claims and restarts can never create a second notification.
- Channels: `inbox` is always on when the feature is on and starts DELIVERED. `mcp_event` uses the new
  event `cloudharness.notification.created` through the existing subscription path, and its delivery
  state mirrors `event_deliveries`. `github` mirrors the workflow's `publish_state`, so there is
  no new GitHub call. Disabled channels create no delivery row.
- `NotificationAdapter` port (`send`, `health`, `revoke`). The inbox and mcp_event adapters
  are real. The second channel used for conformance is a test fake. No Slack or email.
- Preferences: per principal, per channel and per kind. Revocation (unsubscribe or disable) stops
  pending deliveries (state REVOKED).
- Exported for PR6: `emitWaitingForHumanNotification` and `emitApprovalDecidedNotification`.

## Data flow

```
transition (automation finish / agent terminal / PR6 wait+decision)
  -> withEventSavepoint { recordEvent(...) ; emitNotification(kind, subject, payload) }
       -> notifications (UNIQUE dedupe_key) + notification_deliveries per enabled channel
  -> NotificationDispatcher (runner timer): claim pending deliveries (lease), adapter.send, report
  -> API: /dashboard/api/inbox (list, mark read), /dashboard/api/notification-preferences
```

## Files to create

| File | Purpose |
|------|---------|
| `packages/contracts/src/notifications-api.ts` | Notification, delivery and preference DTOs; kinds (`automation.completed`, `automation.failed`, `agent.completed`, `agent.failed`, `workflow.waiting_for_human`, `approval.decided`); internal channel schemas |
| `packages/contracts/test/notifications-api.test.ts` | Schemas |
| `apps/runner/src/notifications/notification-schema.ts` | `initializeNotificationSchema`: `notifications(notification_id PK, principal_id, kind, subject_type, subject_id, dedupe_key UNIQUE, title, payload_json, read_at, created_at)`, `notification_deliveries(notification_id, channel, state CHECK(PENDING,CLAIMED,DELIVERED,FAILED,REVOKED), attempts, lease_until, last_error_class, updated_at, PRIMARY KEY(notification_id, channel))`, `notification_preferences(principal_id, channel, kind, enabled, PRIMARY KEY(...))` |
| `apps/runner/src/notifications/notification-store.ts` | Insert-or-ignore, claim with lease, report, list with cursor |
| `apps/runner/src/notifications/notification-emitter.ts` | `emitNotification` plus the two PR6 emitters |
| `apps/runner/src/notifications/notification-dispatcher.ts` | Lease and backoff loop; 429/500 retries with a bounded attempt count |
| `apps/runner/src/notifications/notification-service.ts` | Inbox and preference API, owner scoped |
| `apps/runner/src/notifications/notification-router.ts` | `/v1/internal/notifications` |
| `apps/runner/test/support/fake-notification-adapter.ts` | Second-channel fake with failure injection |
| `apps/runner/test/notification-store.test.ts`, `notification-dispatcher.test.ts`, `notification-emitter.test.ts` | Unit tests |
| `test/integration/notifications-failure-injection.test.ts` | D5 scenarios using `test/support/coding-harness.ts` |
| `apps/api/dashboard/dashboard-inbox.js` | `/dashboard/inbox` with an unread badge and preferences panel |
| `apps/api/test/dashboard-inbox-router.test.ts`, `dashboard-inbox-ui.test.ts` | Router and UI tests |
| `docs-site/dashboard/inbox.md` | User guide |

## Files to modify (append-only)

| File | Change |
|------|--------|
| `packages/contracts/src/index.ts` | Append the export |
| `packages/contracts/src/events-api.ts` | Append `cloudharness.notification.created` to `MCP_EVENT_NAMES` plus its payload schema |
| `packages/contracts/src/config.ts`, `apps/runner/src/config.ts`, `.env.example` | `NOTIFICATIONS_ENABLED` (false) |
| `apps/runner/src/event-outbox.ts` | The existing emitters call `emitNotification` inside the same savepoint when the flag is on |
| `apps/runner/src/state-store.ts`, `apps/runner/src/app.ts`, `apps/runner/src/index.ts` | Initializer, router and dispatcher timer |
| `apps/api/src/runner-client.ts`, `apps/api/src/dashboard-control-router.ts` | Inbox and preference routes |
| `apps/api/dashboard/dashboard-pages.js`, `apps/api/src/dashboard-assets.ts`, `apps/api/dashboard/dashboard.js`, `dashboard.css` | Registration, nav badge, CSS block |
| `docs/mcp-api.md` (new event), `docs/configuration.md`, `docs/system-architecture.md`, `.agents/skills/cloudharness/**` (event name) | Docs and skill |

## Must not touch

`automation-service.ts`, `automation-schema.ts`, `agent-manager.ts`, `workspace-service.ts`,
`tool-schemas.ts`, `runner-api.ts`, and files owned by PR3 or PR4.

## D5 failure injection (`notifications-failure-injection.test.ts`)

1. Successful coding run: one inbox notification, one MCP event delivery (with a subscription), and a GitHub
   result mirrored. With no subscription and GitHub disabled there are no delivery rows for those channels.
2. Failed run: one `automation.failed` notification.
3. API outage (the event delivery worker is down): the delivery stays PENDING/CLAIMED and recovers
   after the lease expires. The test asserts the visible state transitions.
4. Runner restart mid-claim: the lease is reclaimed and the notification is delivered once.
5. Duplicate claim by two dispatchers: one wins (CAS).
6. Fake adapter 429 then 200, and 500 repeated until the attempt cap: FAILED with `last_error_class` visible.
7. Across all of the above, the agent launch count stays 1 (the harness launcher counter).
8. Preference disabled or revoked mid-retry: REVOKED, no further sends.
9. Cross-principal inbox read is forbidden.

## Tests (Windows-friendly)

```
npm run build -w @cloud-harness/contracts
npx vitest run packages/contracts/test/notifications-api.test.ts packages/contracts/test/events-api.test.ts
npx vitest run apps/runner/test/notification-store.test.ts apps/runner/test/notification-dispatcher.test.ts apps/runner/test/notification-emitter.test.ts apps/runner/test/event-outbox.test.ts
npx vitest run apps/api/test/dashboard-inbox-router.test.ts apps/api/test/dashboard-inbox-ui.test.ts apps/api/test/dashboard-pages.test.ts
npm run build -w @cloud-harness/api
npx vitest run test/integration/notifications-failure-injection.test.ts test/integration/mcp-events-http.test.ts
npm run typecheck && npm run lint && npm run plugin:sync && npm run plugin:check && npm run docs:reference && npm run docs:check
```

Confirm existing test file names (`events-api`, `event-outbox`) with `git ls-files` first. CI
runs all of these in `npm run verify`.

## Risks

| Risk | L x I | Mitigation |
|------|-------|------------|
| Notification write fails and rolls back the transition | L x H | Savepoint-scoped; a failure is caught, logged and counted. It never aborts the parent transition (test) |
| Duplicate notifications | M x M | UNIQUE dedupe key, insert-or-ignore |
| Leaking payload content | L x H | Payload holds ids, titles and links only; titles are bounded and redacted |
| Conflict in event-outbox with other work | L x M | PR5 is the sole owner |

## Rollback

`NOTIFICATIONS_ENABLED=false` stops emission and dispatch. A code revert leaves inert tables.
Subscribers to `cloudharness.notification.created` stop receiving it. The rollback note in
`docs/mcp-api.md` says the event name is feature-flagged.
