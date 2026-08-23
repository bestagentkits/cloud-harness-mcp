---
phase: 4
title: "WAB Mailbox Compatibility Service"
status: pending
priority: P1
effort: ""
dependencies: [1, 2]
---

# Phase 4: WAB Mailbox Compatibility Service

## Overview

Add a dedicated mailbox OpenAI compatibility seam selected before existing provider/RunService construction. It reuses WAB authentication, OpenAI schemas, route shape, and projection utilities, but bypasses BrowserLease, RunService, RunQueue, browser providers, and browser state. A mailbox-specific correlation repository provides idempotent crash recovery without becoming a second work queue.

## Requirements

- Support `/v1/models` and non-streaming `/v1/chat/completions` for logical model ID `chatgpt-mailbox-runtime`.
- Do not claim a ChatGPT model or reasoning effort that the mailbox cannot attest.
- Use the complete isolated static-key gateway lane: public Worker URL, Access service-token assertion, and principal-bound managed API key.
- Prove WAB service transport and ChatGPT widget OAuth transport observe the same opaque mailbox identity before accepting requests.
- Persist only correlation state: principal, idempotency hash, request fingerprint, mailbox message ID, send state, and terminal projection metadata. Do not copy the work queue or plaintext body.
- Bypass `OpenAiCompatibilityService` browser execution and `RunService.admit` for mailbox mode.
- Use atomic expected-consumer-generation send; do not use a status preflight followed by unfenced send.
- Call `mailbox_cancel` on client abort under queued/leased/dispatched semantics.
- Accept only strict `MailboxAgentResponseV1`; omit usage.
- Reject stream, tools, images, attachments, unsupported Responses semantics, model mismatch, and effort claims explicitly.

## Actual Integration Seam

Current owners to inspect/update:

- `src/api/openai/compatibility-config.ts`
- `src/api/openai/openai-schemas.ts`
- `src/api/openai/chat-completions-route.ts`
- `src/api/openai/model-catalog.ts`
- `src/api/app.ts`
- `src/providers/provider.ts` and `provider-router.ts` only if a provider union is retained
- `src/api/openai/compatibility-service.ts` only for shared projection extraction, not browser execution
- `src/runs/run-service.ts` and `run-queue.ts` as paths mailbox mode must not enter
- `src/store/migrations.ts` for mailbox correlation schema
- Create: `src/store/mailbox-correlation-repository.ts`
- Create: `src/api/openai/mailbox-compatibility-service.ts`
- Create: `src/providers/cloud-harness-mailbox-client.ts`
- Create: `test/api/openai-mailbox-chat-completions.test.ts`
- Create: `test/store/mailbox-correlation-repository.test.ts`
- Create: `scripts/mailbox-openai-live-smoke.ts`

Recommended seam:

```text
buildApp
  ├─ mailbox compatibility mode
  │    └─ mailbox-specific route dependency/service
  │         ├─ correlation repository
  │         └─ CloudHarnessMailboxClient
  └─ existing mode
       └─ provider router + RunService + OpenAiCompatibilityService
```

Do not add `cloud-harness-mailbox` to `ProviderKind` unless every discriminator/caller is deliberately updated. A dedicated compatibility mode is smaller and avoids routing mailbox work through the provider/run queue.

## Configuration

```text
MAILBOX_OPENAI_ENABLED=true
MAILBOX_MCP_GATEWAY_URL=https://api.<isolated-test-host>/mcp
MAILBOX_MCP_API_KEY_FILE=<principal-bound managed API key>
MAILBOX_CF_ACCESS_CLIENT_ID_FILE=<isolated Worker/service-token client ID>
MAILBOX_CF_ACCESS_CLIENT_SECRET_FILE=<isolated Worker/service-token secret>
MAILBOX_LOGICAL_MODEL=chatgpt-mailbox-runtime
MAILBOX_SYNC_DEADLINE_MS=<bounded>
MAILBOX_POLL_WAIT_MS=20000
```

The client must send the same service-token headers/path expected by the isolated static gateway architecture plus the managed bearer key. All values are file-backed and outside source.

## Correlation State

```text
principal_id
idempotency_hash
request_fingerprint
mailbox_id
message_id nullable until acknowledged
send_state: prepared | acknowledged | terminal | outcome_unknown
terminal_projection_json bounded/non-secret
created_at, updated_at
UNIQUE(principal_id, idempotency_hash)
```

Crash window protocol:

1. Insert `prepared` correlation with request fingerprint.
2. Call idempotent `mailbox_send` using the same key/fingerprint.
3. Persist returned message ID as `acknowledged`.
4. On restart with `prepared`, replay the same send key/fingerprint and recover the prior message ID—never create a new key.
5. Poll/get terminal response and persist only projection metadata/result required for replay.

## Implementation Steps

1. Add config/schema for mailbox compatibility mode without weakening existing provider enums.
2. Define a route/service interface shared by Chat Completion route registration so mailbox mode can bypass RunService construction.
3. Add the correlation migration/repository and transactional idempotency/fingerprint checks.
4. Implement a typed Cloud Harness MCP client using the existing TypeScript SDK/Streamable HTTP transport and full static-gateway headers.
5. Before first enqueue, call `mailbox_status` through WAB and compare its opaque mailbox ID to the value displayed by the OAuth widget. Abort on mismatch.
6. Normalize bounded OpenAI messages into the shared mailbox request envelope; store no duplicate plaintext work body in WAB.
7. Call `mailbox_send` with expected mailbox ID + consumer generation atomically. An offline/stale consumer returns `agent_runtime_offline` without enqueue.
8. Recover the acknowledged message ID into the correlation row. Handle prepared/acknowledged crash recovery idempotently.
9. Poll `mailbox_get` until terminal/client deadline. Monitor consumer generation/status changes and call `mailbox_cancel` when cancellation remains safe.
10. Map only `MailboxAgentResponseV1` to Chat Completion JSON. Omit usage and return logical model ID.
11. Return explicit errors for offline, cancel requested, response missing, outcome unknown, dead letter, model mismatch, effort supplied, stream, tools, images, attachments, and unsupported endpoints.
12. Add tests for no RunService/RunQueue construction in mailbox mode, idempotency crash windows, principal mismatch, service auth headers, atomic offline send, cancellation states, V1 projection, and unsupported semantics.
13. Preserve every existing browser-provider path/test unchanged.

## Success Criteria

- [ ] Mailbox mode constructs no BrowserLease, RunService, RunQueue, or browser provider.
- [ ] WAB and widget prove the same mailbox identity before send.
- [ ] Full service-token/static-key authentication reaches the isolated mailbox service.
- [ ] One idempotency key maps to one mailbox message across crash/restart windows.
- [ ] Offline/generation mismatch does not enqueue synchronous work.
- [ ] Client abort calls explicit cancellation and never blind-resubmits.
- [ ] Completed V1 response maps to valid OpenAI JSON with logical model ID and no fabricated usage.
- [ ] Existing browser compatibility remains green and original dirty checkout remains untouched.

## Risk Assessment

- **Second queue:** bypass RunService and persist correlation only.
- **Auth 401:** deploy/verify complete static gateway lane before live WAB tests.
- **Principal split:** opaque mailbox identity comparison gates enqueue.
- **Crash after remote send:** same idempotency/fingerprint recovers prior message.
- **Misleading compatibility:** logical runtime model and explicit unsupported errors.
