---
phase: 6
title: "End To End Validation And Decision Gate"
status: pending
priority: P1
effort: ""
dependencies: [5]
---

# Phase 6: End To End Validation And Decision Gate

## Overview

Validate the durable cross-repository MVP only after the Phase 1 autonomy gate passed. Prove strict response projection, caller/tool authority, identity binding, queue/restart/cancellation fencing, browser-free WAB operation, and two sequential autonomous turns. End with an explicit decision; no production merge is authorized.

## Requirements

- Verify bootstrap, automatic first and second turns, strict V1 response submission, and non-streaming OpenAI projection.
- Verify OAuth widget and static WAB lanes share the same opaque mailbox identity.
- Verify model discovery and direct dispatch reject every mutating existing Cloud Harness operation.
- Verify WAB mailbox mode bypasses BrowserLease/RunService/RunQueue and starts no browser/noVNC process.
- Exercise prepared/acknowledged correlation crashes, cancellation, generation TOCTOU, dispatch acceptance, lease renewal, late response, outcome unknown, restart, remount, and client disconnect.
- Capture exact SHAs and sanitized state/tool evidence only.

## Test Matrix

### Auth And Authority

- OAuth draft app authenticates mailbox model/widget registry.
- WAB authenticates through isolated Worker + Access service assertion + managed API key.
- Both transports return the same opaque mailbox ID.
- Widget calls without private capability are rejected.
- WAB service cannot call widget/model-only operations.
- Model tools/list excludes `exec_run`, writes/deletes, Git mutations, hooks, skills, memories mutation, and deployments.
- Named direct calls to excluded operations are rejected at API and runner dispatch.

### Bootstrap

1. Open dedicated conversation and manually invoke `mailbox_open` once.
2. Confirm widget capability remains private and widget mounts/PiP/polls.
3. Confirm no model turn while inbox is empty.

### Autonomous Requests

1. Send one WAB Chat Completion using logical model `chatgpt-mailbox-runtime`.
2. Confirm one correlation row, one mailbox message, matching request fingerprint, and atomic consumer generation.
3. Do not touch keyboard/mouse.
4. Confirm one receive, one follow-up, accepted dispatch, renewals, one read-only tool call, one strict V1 submit, one OpenAI JSON response.
5. Send request two after terminal settlement and confirm a second independent turn without overlap.

### Idempotency And Crash Windows

- Duplicate WAB key/fingerprint returns prior message/result.
- Same key with different fingerprint conflicts.
- Crash after correlation `prepared` but before send recovers safely.
- Crash after remote send but before acknowledged persistence replays same mailbox key and recovers prior message ID.
- Restart while queued preserves message.
- Restart while leased/pre-dispatch requeues only under current attempt rules.
- Restart/lost widget after accepted dispatch never auto-redelivers; request becomes completed or outcome_unknown.

### Lease And Cancellation

- Renewal extends only current generation/attempt before absolute deadline.
- Stale generation/token renewal fails.
- Completion after the former 120-second boundary remains single-dispatch.
- Release is allowed only before accepted dispatch.
- Client abort while queued cancels atomically.
- Client abort after dispatch produces cancel_requested and does not blind-resubmit.
- Late response semantics are deterministic and idempotent.

### Runtime And Compatibility

- WAB process/mount/port inspection proves no Chrome/X11/VNC/profile surface.
- `/v1/models` reports only logical mailbox runtime model; effort claims/mismatches are rejected.
- Valid V1 content projects to Chat Completion JSON; unknown response version/fields fail.
- `usage` is absent; stream/tools/images/attachments/unsupported endpoints fail explicitly.
- Offline/generation mismatch fails fast without enqueue.

## Related Evidence

- Cloud Harness contract/runner/API/MCP/security tests
- WAB mailbox service/correlation/OpenAI projection tests
- `plans/260823-0614-chatgpt-mailbox-runtime-mvp/reports/mvp-execution.md` created only during implementation
- Sanitized request IDs, state transitions, tool names/status, auth lane health, process lists, and commit SHAs
- No raw message body beyond fixed canaries, token, key, capability, OAuth assertion, or tool arguments

## Implementation Steps

1. Record branch/deployed SHAs, hostnames, projects, runner instance, and sanitized readiness.
2. Run focused and full repository gates before live interaction.
3. Run auth-only static-gateway and mailbox identity-binding checks.
4. Run tools/list and direct-dispatch read-only allowlist negative matrix.
5. Execute bootstrap and verify widget private capability/mount/poll.
6. Execute first and second autonomous requests with no interaction.
7. Validate exact V1→OpenAI JSON projection and no native DOM/text dependency.
8. Execute idempotency/correlation crash-window tests.
9. Execute consumer generation/offline TOCTOU tests.
10. Execute renewal, accepted-dispatch loss, >120-second completion, outcome-unknown, and cancellation tests.
11. Refresh/remount widget before and after dispatch; restart only isolated runner in queued/leased/dispatched states.
12. Inspect WAB runtime for absence of browser/noVNC components.
13. Review logs/audits for secret/content leakage.
14. Classify outcome and stop/preserve isolated stacks under owner direction.

## Decision Gate

| Outcome | Required Evidence | Next Action |
|---|---|---|
| Autonomous MVP passed | Phase 1 and durable matrix pass; two turns need no gesture; authority/identity/fencing/recovery pass | Plan productization separately; no production merge |
| Semi-autonomous only | Widget receives mail but host requires user gesture | Keep operator-assisted inbox only |
| Host lifecycle failure | Widget unmounts, callback cannot trigger turn, private capability cannot be protected, or second turn fails | Stop; no browser automation workaround |
| Contract/security failure | Duplicate/lost action, cross-profile access, mutating tool exposure, principal mismatch, malformed response, or unrecoverable state | Block until root contract is redesigned |

## Success Criteria

- [ ] Two autonomous sequential requests complete after one bootstrap interaction.
- [ ] Every response is strict V1 and maps to valid OpenAI JSON.
- [ ] No native ChatGPT DOM/text or fabricated model/usage claim is used.
- [ ] No duplicate turn/tool/response occurs across retry, remount, long turn, cancellation, or restart.
- [ ] Caller profiles and read-only allowlist are enforced at discovery and dispatch.
- [ ] WAB/ChatGPT identities match and WAB uses the complete static gateway lane.
- [ ] WAB mailbox process is browser-free and bypasses its existing queue.
- [ ] Production remains unchanged.
- [ ] Result is classified before any merge/production plan.

## Risk Assessment

- **False pass:** two turns plus recovery/security matrix, not one smoke.
- **Hidden host gesture:** zero input-device interaction during autonomous cases.
- **Duplicate accepted turn:** dispatch fence/renewal/outcome unknown, no auto-redelivery.
- **Misleading OpenAI parity:** logical model, V1 schema, no usage/stream claims.
- **Accidental rollout:** isolated branches/stacks; decision gate is not deployment approval.
