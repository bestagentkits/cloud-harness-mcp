---
title: "ChatGPT Mailbox Runtime MVP"
description: "Prove, before durable investment, that a Cloud Harness MCP App widget can long-poll a mailbox, create a new ChatGPT turn without user composition, force a schema-validated response tool, and return that result through a browser-free WAB OpenAI compatibility seam."
status: pending
priority: P1
effort: ""
tags: [mcp-apps, mailbox, chatgpt, openai-compatibility, cloud-harness, wab, vps-mvp]
created: 2026-08-23
branch: feat/chatgpt-mailbox-runtime-mvp
blocks: [260821-0938-web-assistant-openai-compatibility-parity]
repositories:
  cloudHarness: https://github.com/therichardngai-code/cloud-harness-mcp
  wab: https://github.com/therichardngai-code/wab
---

# ChatGPT Mailbox Runtime MVP

## Outcome

Prove this loop in two stages while a dedicated ChatGPT tab remains open:

```text
Stage A — capability spike
in-memory pending request
→ mounted draft MCP App widget
→ bounded app-only receive
→ sendFollowUpMessage()
→ second autonomous ChatGPT turn
→ strict submit tool

Stage B — MVP only if Stage A passes
OpenAI-compatible request
→ browser-free WAB mailbox compatibility service
→ Cloud Harness durable mailbox
→ widget long poll
→ ChatGPT read-only agent turn
→ agent_response_submit(MailboxAgentResponseV1)
→ WAB OpenAI-compatible JSON
→ widget resumes polling
```

The autonomous MVP fails if the second turn needs another user click, if the widget is not kept mounted, if app-only calls cannot be protected, or if the model cannot reliably submit a strict response. Browser automation is not an allowed workaround.

## Constraints

- Run a thin Apps SDK/host capability spike before final schemas, migrations, WAB integration, docs, or durable queue work.
- Preserve the Cloud Harness single-owner trust model and API/runner boundary.
- Runner owns durable mailbox state, leasing, idempotency, encryption, audit, lifecycle, and principal scoping after the spike passes.
- API owns MCP negotiation, separate capability-profile registries, scoped caller classification, and UI resource registration; it must not acquire Docker or state authority.
- WAB reuses OpenAI authentication/schemas/routes/projection only through a dedicated mailbox compatibility service that bypasses BrowserLease, RunService, and RunQueue.
- Cloud Harness SQLite is the only work queue. WAB persists only a principal-scoped correlation/idempotency record.
- One principal, one inbox, one widget consumer generation, one in-flight request, one logical mailbox runtime model.
- The autonomous ChatGPT draft app receives an enforced server-side allowlist: mailbox model tools plus an explicit read-only Cloud Harness subset. Annotations and prompts are not authorization.
- Widget operations require a server-validated widget session capability delivered only in widget-private metadata; WAB service operations use a separate scoped registry and credential lane.
- Use bounded long polls below Cloud Harness's 60-second API-to-runner timeout; target `waitMs=20_000`.
- Dispatched model turns are fenced. A lost widget after `sendFollowUpMessage()` acknowledgement becomes `outcome_unknown` at the absolute deadline; it is not automatically redelivered.
- Message/response bodies are encrypted and bounded. Raw bodies, OAuth material, service tokens, API keys, widget capabilities, delivery tokens, and tool arguments never enter logs.
- Implementation uses clean worktrees from pinned refs. Production services/state/secrets/hostnames remain untouched.

## Non-goals

- A 24/7 agent when ChatGPT, the tab, or widget is closed.
- True token streaming; MVP supports non-streaming Chat Completions only.
- Multiple mailboxes/consumers, priorities, attachments, email, public webhook ingress, or callbacks.
- Claiming or changing an exact ChatGPT model/effort through UI automation. WAB exposes an honest logical model ID such as `chatgpt-mailbox-runtime` and no authoritative effort claim.
- Full WAB replacement, browser-provider cleanup, or upstream productization.
- Autonomous mutating Cloud Harness tools, auto-approval, or broad 52-tool discovery.
- Production merge/deployment from an MVP pass.

## Confirmed Starting State

- Owner fork exists at `therichardngai-code/cloud-harness-mcp`.
- Cloud Harness base: `4149ed8c3ec27de3fb6db511b3ed361a46988811`.
- WAB base: `3c2000a44624e4ab46b100afe9072256f2731be2`.
- Cloud Harness MCP server currently registers every `TOOL_SPECS` entry uniformly; it has no UI resource or caller capability profile.
- Cloud Harness runner dispatch currently assumes workspace scope after `workspace_open/list`; mailbox operations require a principal-global dispatcher.
- The static API-key lane requires a dedicated Worker, path-scoped Access application, service assertion, and principal-bound managed API key—not an API key alone.
- WAB's current OpenAI flow constructs RunService/RunQueue even for direct providers; mailbox mode must bypass that path.
- WAB's current container always starts Xvfb/x11vnc/noVNC; mailbox mode needs a separate gateway-only process/image.
- OpenAI documents `callTool` and `sendFollowUpMessage`, but autonomous callback behavior, widget persistence, app-only visibility, and private metadata assumptions remain unproven until Phase 1.

## Architecture Decisions

1. Phase 1 is a throwaway-capable in-memory vertical spike using explicitly registered probe tools. Durable work is gated on two autonomous turns.
2. Final mailbox operations are divided into separate registries/capability profiles: model, widget, and service. Passive `_meta` visibility is never the only authorization control.
3. A mailbox-specific ChatGPT MCP endpoint exposes only `mailbox_open`, `agent_response_submit`, and an explicit read-only Cloud Harness allowlist; all mutating existing tools are absent and rejected at dispatch.
4. `mailbox_open` returns a widget session capability in widget-private metadata. Widget lease/receive/release/renew calls require that capability.
5. WAB uses the existing static-key gateway architecture completely: dedicated Worker URL, service token lane, Access assertion, and principal-bound API key created under the same ChatGPT OAuth principal.
6. `mailbox_status` exposes an opaque stable mailbox identity. Widget OAuth and WAB service transport must observe the same identity before enqueue is enabled.
7. WAB mailbox mode branches at the composition/route seam before RunService and stores only correlation state; Cloud Harness remains sole queue authority.
8. `MailboxAgentResponseV1` is a versioned cross-repository schema. Native ChatGPT text and token usage are never authoritative.
9. Dispatch uses consumer generation, attempt number, delivery capability, renewable lease, accepted-dispatch state, and absolute deadline fencing.
10. A dedicated gateway-only WAB image/entrypoint starts no Chrome, X11, profile, or noVNC processes/mounts/ports.
11. VPS testing uses isolated owner-fork branches, exact SHAs, projects, state roots, secrets, Access apps, Worker gateway, and hostnames.

## Final Operation Contract (After Spike Passes)

| Operation | Registry/caller | Purpose |
|---|---|---|
| `mailbox_open` | ChatGPT model | Render widget; return widget-private session capability. |
| `mailbox_send` | WAB service | Idempotently enqueue under an expected fresh consumer generation. |
| `mailbox_receive` | widget capability | Long-poll and lease one queued request. |
| `mailbox_get` | widget + WAB service | Read request state and validated response. |
| `mailbox_status` | widget + WAB service | Read opaque mailbox identity, consumer generation/presence, and bounded counts. |
| `mailbox_renew` | widget capability | Renew the current delivery lease before absolute deadline. |
| `mailbox_release` | widget capability | Release a pre-dispatch failure or dead-letter it. |
| `mailbox_cancel` | WAB service | `queued→cancelled`; `leased/dispatched→cancel_requested`. |
| `agent_response_submit` | ChatGPT model | Atomically validate/commit `MailboxAgentResponseV1`. |

```text
queued → leased → dispatched → completed
  │         │          ├→ cancel_requested
  │         ├→ queued  (release before dispatch)
  │         └→ dead_letter
  └→ cancelled

dispatched + lost/expired absolute deadline → outcome_unknown (no automatic redelivery)
```

## MailboxAgentResponseV1

```json
{
  "version": 1,
  "status": "completed",
  "message": {
    "role": "assistant",
    "content": [{ "type": "output_text", "text": "bounded text" }]
  },
  "finishReason": "stop",
  "data": null,
  "error": null
}
```

WAB supports only the documented V1 fields and omits token usage. Unknown versions/fields are rejected.

## Branch And Isolation Strategy

### Cloud Harness

```text
remote: fork = https://github.com/therichardngai-code/cloud-harness-mcp.git
branch: feat/chatgpt-mailbox-runtime-mvp
base:   4149ed8c3ec27de3fb6db511b3ed361a46988811
```

### WAB

```text
remote: origin = https://github.com/therichardngai-code/wab.git
branch: feat/cloud-harness-mailbox-provider-mvp
base:   3c2000a44624e4ab46b100afe9072256f2731be2
```

Both use clean worktrees. Original dirty checkouts remain untouched.

## Phases

| # | Phase | Status | Dependencies |
|---|---|---|---|
| 1 | [Capability Spike And Branch Isolation](./phase-01-capability-spike-and-branch-isolation.md) | Blocked on ChatGPT host validation | None |
| 2 | [Durable Mailbox Core](./phase-02-durable-mailbox-core.md) | Pending | 1 pass |
| 3 | [MCP App Widget](./phase-03-mcp-app-widget.md) | Pending | 1 pass, 2 |
| 4 | [WAB Mailbox Compatibility Service](./phase-04-wab-mailbox-provider.md) | Pending | 1 pass, 2 |
| 5 | [Fork Branch VPS Test Deployment](./phase-05-fork-branch-vps-test-deployment.md) | Pending | 3, 4 |
| 6 | [End To End Validation And Decision Gate](./phase-06-end-to-end-validation-and-decision-gate.md) | Pending | 5 |

## MVP Success Criteria

- [ ] Phase 1 proves resource mount, private widget metadata, widget-only call enforcement, automatic `sendFollowUpMessage`, PiP/mount persistence, strict submit, and a second autonomous turn on the actual ChatGPT draft host.
- [ ] Model discovery/dispatch excludes every mutating existing Cloud Harness operation.
- [ ] WAB and widget resolve to the same opaque mailbox identity through the complete service-token/static-key and OAuth lanes.
- [ ] WAB bypasses RunService/RunQueue and runs in a gateway-only process with no browser/noVNC surface.
- [ ] One OpenAI request maps to one durable mailbox request and one `MailboxAgentResponseV1`.
- [ ] Duplicate/cancel/restart/unmount/lease cases do not cause duplicate ChatGPT turns or tool actions.
- [ ] A second request creates the next turn automatically after terminal settlement.
- [ ] Offline/lost runtime fails explicitly; no silent long timeout or blind redelivery.
- [ ] Production services/data remain unchanged.
- [ ] Decision gate records autonomous pass, semi-autonomous only, host failure, or contract failure.

## Red Team Review

### Session — 2026-08-23

**Findings:** 15 deduplicated, 15 accepted, 0 rejected.
**Severity breakdown:** 2 Critical, 12 High, 1 Medium.

| # | Finding | Severity | Disposition | Applied To |
|---|---|---|---|---|
| 1 | Full static API-key gateway lane missing | Critical | Accept | Phases 4-5 |
| 2 | Autonomous read-only boundary not enforced | Critical | Accept | Phases 1, 3, 6 |
| 3 | App/service/model visibility is not server authorization | High | Accept | Phases 1, 3 |
| 4 | Apps SDK autonomy must be proved before persistence | High | Accept | Phase 1 and phase order |
| 5 | Advertised model/effort cannot be enforced | High | Accept | Phase 4/model contract |
| 6 | Existing WAB RunService would create a second queue | High | Accept | Phase 4 |
| 7 | WAB needs a dedicated mailbox correlation store | High | Accept | Phase 4 |
| 8 | Lease expiry can duplicate accepted turns | High | Accept | Phases 1-3 |
| 9 | ChatGPT OAuth and WAB API key may resolve different principals | High | Accept | Phases 4-5 |
| 10 | Mailbox cancellation operation is missing | High | Accept | Phases 1, 2, 4 |
| 11 | Consumer presence preflight has a TOCTOU race | High | Accept | Phases 2, 4 |
| 12 | WAB provider file map/discriminators were inaccurate | High | Accept | Phase 4 |
| 13 | WAB mailbox mode still started browser/noVNC | High | Accept | Phases 4-5 |
| 14 | Cross-repository response payload was not frozen | High | Accept | Phases 1, 4 |
| 15 | Mailbox store/reaper/runner cleanup ownership was incomplete | Medium | Accept | Phases 2, 5 |

### Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all six phase files.
- Decision deltas checked: capability spike ordering; nine-operation contract; caller registries; read-only allowlist; static gateway; principal identity; WAB queue bypass; correlation store; lease fencing; cancellation; browser-free process; response V1; runner lifecycle; cleanup labels.
- Reconciled stale references: six/seven-tool counts, nonexistent wait tool, Work/Browser provider assumptions, model/effort guarantee, passive visibility, API-key-only auth, Compose-only cleanup.
- Unresolved contradictions: 0.

## Rollback

- Stop only isolated MVP projects and exact runner-instance-labeled containers.
- Revoke test API key, Worker service token, Access apps, and draft ChatGPT app.
- Preserve test state until evidence acceptance; delete only with explicit authorization.
- Production requires no rollback because it is never changed.

## Open Questions

- Does the current ChatGPT host support the complete Phase 1 autonomous path without a user gesture?
- Does private tool result metadata remain inaccessible to the model while available to the widget?
- Can the pinned SDK/host implement app-only calls with server-verifiable capability semantics?
- Which exact isolated hostnames/ports will the owner authorize after Phase 1 passes?

<!-- slug: chatgpt-mailbox-runtime-mvp -->
