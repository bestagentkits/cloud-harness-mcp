---
phase: 2
title: "Durable Mailbox Core"
status: pending
priority: P1
effort: ""
dependencies: [1]
---

# Phase 2: Durable Mailbox Core

## Overview

After Phase 1 passes, replace the in-memory probe with a runner-owned encrypted queue, caller capability profiles, consumer generation, dispatch fencing, renewable leases, cancellation, strict response V1, and explicit process lifecycle. SQLite is authoritative; waiters are disposable acceleration.

## Requirements

- Functional: implement the nine final operations in separate model/widget/service registries.
- Functional: enqueue only against an expected fresh consumer generation, atomically preventing the presence-check/send race.
- Functional: lease, renew, mark accepted dispatch, submit strict response, release pre-dispatch failure, cancel, get, and report status.
- Reliability: accepted model turns are never automatically redelivered; lost dispatched turns become `outcome_unknown` at an absolute deadline.
- Reliability: runner restart preserves queued/completed state and safely handles leased/dispatched attempts.
- Security: widget operations require a server-validated widget session capability; service operations require a scoped service caller profile.
- Security: autonomous model discovery/dispatch uses an explicit read-only allowlist enforced in API and runner, not annotations.
- Security: encrypt bodies with runner key material and exclude secrets/content from logs/audit.

## Architecture

```text
RunnerOperationService.execute(principal, callerProfile, operation, input)
  ├─ final mailbox operation → MailboxService
  └─ allowed workspace op    → WorkspaceService

MCP/API registries
  ├─ mailbox-model:  mailbox_open, agent_response_submit, read-only allowlist
  ├─ mailbox-widget: receive/get/status/renew/release + widget capability
  └─ mailbox-service: send/get/status/cancel + service credential
```

Process ownership:

```text
apps/runner/src/index.ts
  ├─ one StateStore/database authority
  ├─ migrations on the existing database handle
  ├─ one MailboxStore
  ├─ one MailboxService.start()/stop()
  ├─ one waiter registry
  └─ one lease/retention reaper cleared before DB close
```

State machine:

```text
queued → leased → dispatched → completed
  │         │          ├→ cancel_requested
  │         ├→ queued/dead_letter (release before accepted dispatch)
  │         └→ cancelled
  └→ cancelled

dispatched + absolute deadline → outcome_unknown (manual decision, no redelivery)
```

## Final Contracts

- `mailbox_open`: model registry; creates/recovers widget session capability in widget-private metadata.
- `mailbox_send`: service registry; includes expected mailbox identity and fresh consumer generation.
- `mailbox_receive`: widget registry; bounded poll and lease.
- `mailbox_get`: widget/service registry; request state and response.
- `mailbox_status`: widget/service registry; opaque mailbox identity, generation, online/poll state, bounded counts.
- `mailbox_renew`: widget registry; renew current attempt before absolute deadline.
- `mailbox_release`: widget registry; release only before accepted dispatch or dead-letter.
- `mailbox_cancel`: service registry; queued cancellation or dispatched cancel request.
- `agent_response_submit`: model registry; exact `MailboxAgentResponseV1` and current attempt fencing.

`MailboxAgentResponseV1` is shared verbatim with WAB through a generated or copied contract package/artifact; `ToolResult.data` is not the response schema.

## Related Code Files

- Create: `apps/runner/src/mailbox-store.ts`
- Create: `apps/runner/src/mailbox-service.ts`
- Create: `apps/runner/src/runner-operation-service.ts`
- Modify: `apps/runner/src/index.ts`
- Modify: `apps/runner/src/app.ts`
- Modify: `apps/runner/src/workspace-service.ts` only to remove/replace top-level dispatch ownership
- Modify: the existing metadata migration owner; do not create an independent database connection/migration authority
- Modify: `packages/contracts/src/runner-api.ts`
- Modify: `packages/contracts/src/tool-schemas.ts`
- Create: `packages/contracts/src/mailbox-contracts.ts`
- Create: `packages/contracts/test/mailbox-contracts.test.ts`
- Create: `apps/runner/test/mailbox-store.test.ts`
- Create: `apps/runner/test/mailbox-service.test.ts`
- Modify: restart/security/integration tests

## Data Model Additions

Message rows include:

```text
principal_id, mailbox_id, message_id, sequence
sender_id, idempotency_hash, request_fingerprint
status, consumer_generation, delivery_attempt
lease_token_hash, lease_expires_at
absolute_deadline, dispatch_state, dispatch_accepted_at
available_at, attempts, created_at, completed_at
body encryption columns
```

Response rows store exactly one encrypted `MailboxAgentResponseV1` per message. Widget session rows/records store capability hash, generation, expiry, and last-seen metadata; raw capabilities are never persisted or returned to the model.

## Implementation Steps

1. Freeze the nine-operation schemas and exact V1 response payload only after Phase 1 pass evidence.
2. Split operation registries/caller profiles. Add negative tests proving each caller cannot invoke operations outside its profile.
3. Add a mailbox-specific model capability profile that excludes every mutating existing operation at both discovery and runner dispatch.
4. Apply forward-only mailbox migrations using the existing runner database handle before service start.
5. Instantiate one process-wide MailboxStore/MailboxService in `index.ts`; implement `start`/`stop` to register/abort waiters and clear/await reapers before database close.
6. Reuse the runner keyring with mailbox-specific associated-data contexts and unique nonces.
7. Implement idempotent send using `(principal,sender,idempotencyKey,requestFingerprint)` and atomically require expected mailbox identity + fresh consumer generation.
8. Implement one active waiter/consumer, bounded receive, consumer-generation fencing, FIFO lease, attempt number, delivery capability hash, and request abort cleanup.
9. Implement `mailbox_renew` so the mounted widget extends only the current attempt before absolute deadline.
10. Add a durable `dispatch_state`. After `sendFollowUpMessage()` acceptance, mark the attempt `dispatched`; never requeue it automatically. At deadline, move to `outcome_unknown` unless a valid response arrives.
11. Implement `mailbox_release` only for pre-dispatch failure. Released attempts requeue/dead-letter under attempt bounds.
12. Implement `mailbox_cancel`: queued→cancelled; leased/dispatched→cancel_requested. Late response semantics are explicit and idempotent.
13. Implement `agent_response_submit` with widget/model caller authorization, attempt/generation/delivery-token CAS, strict V1 validation, and atomic response insert/audit.
14. Implement status/get with an opaque stable `mailboxId` used to prove WAB and widget principal identity match.
15. Add lease/retention reaper and restart reconciliation. Expired pre-dispatch leases may requeue; dispatched attempts never duplicate.
16. Add audit transitions without raw bodies/tokens/arguments.
17. Test concurrency, lost waiter, accepted-dispatch crash, late response, renewal, cancellation phases, idempotency collision, wrong caller profile, wrong principal, and process shutdown.
18. Run focused tests then `npm run verify`.

## Success Criteria

- [ ] Caller registries and runner dispatch reject every cross-profile operation.
- [ ] Autonomous model profile cannot discover or invoke any mutating existing tool.
- [ ] Send and consumer presence/generation check are atomic.
- [ ] One request has one current consumer generation/attempt/delivery capability.
- [ ] Widget renews a running attempt; accepted dispatch cannot be automatically redelivered.
- [ ] Cancellation is explicit and idempotent for queued and dispatched states.
- [ ] Strict V1 response commits once; malformed, stale, replayed, cross-principal, and late submissions fail safely.
- [ ] Restart/shutdown loses no queued/completed state and leaks no waiter/reaper.
- [ ] No body/token/capability enters logs or audit.
- [ ] Existing workspace behavior remains green.

## Risk Assessment

- **Duplicate turns:** dispatch fencing + consumer generation + no post-dispatch auto-redelivery.
- **Long model run:** renewable lease bounded by absolute deadline; outcome unknown rather than duplication.
- **Caller spoofing:** separate route/registry/capability profiles and server/runner enforcement.
- **Database lifecycle:** one shared handle and explicit service stop before stores close.
- **TOCTOU offline race:** expected consumer generation is part of send transaction.
