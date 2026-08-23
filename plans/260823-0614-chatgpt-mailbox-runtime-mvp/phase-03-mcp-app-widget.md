---
phase: 3
title: "MCP App Widget"
status: pending
priority: P1
effort: ""
dependencies: [1, 2]
---

# Phase 3: MCP App Widget

## Overview

Productize the Phase 1-proven widget against the durable mailbox. The widget authenticates app-only calls with a private capability, keeps one renewable/fenced delivery in flight, marks accepted follow-up dispatch, and resumes polling only after authoritative terminal state.

## Requirements

- Phase 1 autonomous host/capability gate is passed and its probe tools are removed/replaced.
- `mailbox_open` renders a self-contained widget and returns a session capability only in widget-private metadata.
- Widget polls, renews, marks accepted dispatch, gets status, and releases pre-dispatch failure through the widget registry.
- Delivery creates exactly one component-authored follow-up without user input.
- `agent_response_submit` is the final model tool and accepts only the current attempt's `MailboxAgentResponseV1`.
- Model discovery includes only mailbox model tools plus the explicit read-only Cloud Harness allowlist.
- No direct OAuth/API key, WebSocket, SSE, external asset, or browser storage authority.
- No automatic approval/reconnect/destructive action.

## Architecture

```text
mailbox_open
  ├─ model-visible tool result: sanitized mailbox status
  └─ widget-private metadata: widgetSessionCapability

Widget
  ├─ mailbox_receive(capability, generation, waitMs)
  ├─ mailbox_renew(capability, messageId, attempt)
  ├─ sendFollowUpMessage(protocol envelope)
  ├─ mark dispatch accepted through bounded app operation/receive state
  ├─ mailbox_get(capability, messageId)
  └─ mailbox_release only before dispatch acceptance
```

Follow-up envelope contains request ID, attempt, delivery capability, input, response schema version, and `requiredFinalTool=agent_response_submit`. It labels mailbox content as untrusted user data.

After `sendFollowUpMessage()` resolves, widget marks dispatch accepted and continues renewal/status polling while the model turn runs. If the widget disappears after accepted dispatch, server expiry becomes `outcome_unknown`, never a duplicate turn.

## Related Code Files

- Modify: `apps/api/src/mcp-server.ts`
- Create: `apps/api/src/mailbox-mcp-profile.ts`
- Create: `apps/api/src/mailbox-widget-resource.ts`
- Create: `apps/api/mailbox-widget/`
- Modify: `docker/api.Dockerfile` if assets require explicit copy
- Modify: `packages/contracts/src/mailbox-contracts.ts`
- Create: `apps/api/test/mailbox-widget-contract.test.ts`
- Modify/create MCP discovery and authorization integration tests
- Modify: `docs/mcp-api.md`
- Modify: `docs-site/ai-tools/chatgpt.md`
- Regenerate references through owning scripts only

## Implementation Steps

1. Remove probe-only registrations after preserving Phase 1 evidence.
2. Register a dedicated mailbox ChatGPT server/profile/path. Do not reuse the production full-tool `TOOL_SPECS` loop.
3. Register only `mailbox_open`, `agent_response_submit`, and the approved read-only Cloud Harness subset for model discovery.
4. Register widget operations in the host-supported app-call surface. Require the private widget capability server-side even if visibility metadata is ignored.
5. Return widget capability only through metadata proven private in Phase 1; structured model content must not contain it.
6. Register a bounded self-contained `ui://cloud-harness/mailbox.html` resource.
7. Feature-detect bridge APIs and render unsupported/offline states explicitly.
8. Generate/recover a non-secret consumer ID in widget state; reconcile it against server consumer generation.
9. Start one `mailbox_receive(waitMs=20_000)` and abort it on unmount/suspension.
10. On delivery, persist in-flight message/attempt, start bounded lease renewal, stop receive, and call `sendFollowUpMessage()` once.
11. After the follow-up Promise resolves, mark dispatch accepted. A rejected Promise permits release/retry; an accepted dispatch does not.
12. Continue `mailbox_renew` and `mailbox_get` while the model turn runs. Stop renewal at terminal/absolute deadline/unmount.
13. Require `agent_response_submit` as the final tool. Tool result says to end the turn immediately.
14. After completed/cancelled/dead-letter, wait a settle guard and resume receive. After `outcome_unknown`, stop and require operator decision.
15. Request PiP and report current mount/poll/generation/in-flight state.
16. Add mocked bridge tests for two turns, capability omission, direct unauthorized widget calls, dispatch rejection/acceptance, renewal, remount, terminal resume, and outcome unknown.
17. Add live negative tests that named mutating tools are absent and rejected even if explicitly requested by mailbox content.
18. Refresh only the isolated draft ChatGPT app snapshot.

## Success Criteria

- [ ] Private capability is available to widget, absent from model context, and required by server.
- [ ] Model tools/list and dispatch exclude every mutating existing operation.
- [ ] One delivery produces one accepted follow-up and one strict response.
- [ ] Widget renews while the turn runs and never auto-redelivers accepted dispatch.
- [ ] Two sequential requests create two non-overlapping autonomous turns.
- [ ] Refresh before dispatch safely releases/retries; refresh after dispatch produces no duplicate.
- [ ] Offline, approval, reconnect, and outcome-unknown states are explicit.
- [ ] No native ChatGPT DOM/text enters mailbox state or WAB response.

## Risk Assessment

- **Private metadata not actually private:** Phase 1 fails; do not continue.
- **Host visibility ignored:** widget capability and separate registry enforce authorization independently.
- **Gesture/remount limitation:** classify semi-autonomous/fail; no Playwright workaround.
- **Duplicate turns:** consumer generation, accepted-dispatch fence, renewals, and outcome unknown.
- **Prompt injection:** server-enforced read-only model profile and untrusted-user envelope.
