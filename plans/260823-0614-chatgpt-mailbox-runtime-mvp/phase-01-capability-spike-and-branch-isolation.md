---
phase: 1
title: "Capability Spike And Branch Isolation"
status: blocked
priority: P1
effort: ""
dependencies: []
---

# Phase 1: Capability Spike And Branch Isolation

## Overview

Create clean owner-fork worktrees, then prove the decisive ChatGPT/MCP App capabilities with an in-memory vertical slice before committing final contracts, migrations, encryption, WAB integration, docs, or durable queue code. Failure at this gate ends or downgrades the MVP without browser automation.

## Requirements

- Functional: mount one authenticated MCP App resource from a draft Cloud Harness endpoint.
- Functional: widget performs one bounded delayed app-only receive call and receives one in-memory probe message.
- Functional: widget calls `sendFollowUpMessage()` from the receive callback without user input and triggers a new model turn.
- Functional: model calls a strict probe submit tool; widget resumes and proves a second autonomous turn.
- Security: probe proves widget-private metadata is not model-visible and app-only calls require a server-validated capability.
- Security: probe ChatGPT endpoint discovers/dispatches only probe tools plus an explicit harmless read-only tool; mutating existing tools are absent and denied.
- Workflow: implementation occurs only in clean worktrees from pinned owner-fork refs.

## Architecture

Throwaway-capable spike:

```text
Explicit draft MCP server profile
  ├─ mailbox_probe_open       model visible; UI resource
  ├─ mailbox_probe_receive    app callable; requires private widget capability
  ├─ agent_probe_submit       model visible; strict ProbeResponseV1
  └─ one harmless read-only capability

In-memory probe state
  └─ one pending request, one consumer, no migration/reaper/encryption
```

The spike must also test actual `tools/list`/host discovery behavior. `_meta.ui.visibility` alone is not accepted as authorization evidence.

## Related Code Files

### Cloud Harness

- Modify: `apps/api/src/mcp-server.ts`
- Create: `apps/api/src/mailbox-probe-server.ts`
- Create: `apps/api/src/mailbox-probe-widget-resource.ts`
- Modify: `apps/api/src/app.ts` only for an isolated feature-gated draft path
- Create: `apps/api/test/mailbox-probe-contract.test.ts`
- Inspect: `apps/api/package.json` and pinned MCP SDK APIs before dependency changes
- Do not modify runner SQLite schemas in this phase

### Branch Isolation

- Cloud Harness fork: `https://github.com/therichardngai-code/cloud-harness-mcp`
- Cloud Harness branch: `feat/chatgpt-mailbox-runtime-mvp`
- Cloud Harness base: `4149ed8c3ec27de3fb6db511b3ed361a46988811`
- WAB branch reserved after pass: `feat/cloud-harness-mailbox-provider-mvp`
- WAB base: `3c2000a44624e4ab46b100afe9072256f2731be2`

## Implementation Steps

1. Verify the owner fork contains the pinned Cloud Harness base and add a separate `fork` remote without repointing `origin`.
2. Create a clean Cloud Harness worktree/branch and record original checkout status; never stage `.deploy`, plans, or unrelated owner work into implementation commits.
3. Do not create the WAB worktree until the host capability gate passes; only verify the pinned WAB base exists.
4. Inspect `@modelcontextprotocol/server` 2.0.0 for resource registration, tool metadata, private result metadata, and app bridge compatibility. Add `@modelcontextprotocol/ext-apps` only if required by the documented pinned API.
5. Register an isolated feature-gated probe MCP endpoint/server profile; do not alter production `/mcp` discovery.
6. Register a self-contained `ui://` probe widget and a model-visible `mailbox_probe_open` tool.
7. Generate a random widget session capability on open; return it only in widget-private result metadata. Store only a hash/server record.
8. Require that capability on `mailbox_probe_receive`; verify direct model/service calls without it are rejected.
9. Add one in-memory delayed probe request and make the mounted widget receive it through a bounded app bridge tool call.
10. From the long-poll callback, invoke `sendFollowUpMessage()` exactly once without mouse/keyboard input.
11. Require the new model turn to call `agent_probe_submit` with strict `ProbeResponseV1`; reject unknown fields and native-text-only completion.
12. Resume polling and deliver a second probe request to prove a second autonomous turn after the first turn settles.
13. Request PiP and verify widget mount/poll continuity after bootstrap and after both turns.
14. Inspect actual model tool discovery. Prove all existing mutating tools (`exec_run`, writes/deletes, Git mutations, hooks, skills, deployments) are absent and rejected at dispatch.
15. Record host behavior as pass, semi-autonomous, or fail. If user gesture, remount failure, private metadata leakage, app-only bypass, or second-turn failure occurs, stop before Phase 2.
16. Only after pass, remove/replace probe-only operations with the final versioned contracts in Phase 2 and create the clean WAB worktree.


## Current Evidence

- Cloud Harness owner-fork worktree created at `C:\SaaS\private\worktrees\cloud-harness-mcp-feat-chatgpt-mailbox-runtime-mvp` on branch `feat/chatgpt-mailbox-runtime-mvp`.
- Verified Cloud Harness base commit `4149ed8c3ec27de3fb6db511b3ed361a46988811` and WAB base commit `3c2000a44624e4ab46b100afe9072256f2731be2` exist locally.
- Implemented local gated probe profile at `/mcp-mailbox-probe` with in-memory `mailbox_probe_open`, app-capability `mailbox_probe_receive`, strict `agent_probe_submit`, one allowlisted `workspace_list`, and no durable mailbox schema or WAB provider code.
- Local contract checks passed: `npm run lint`, `npm run typecheck`, and `npm test -- apps/api/test/mailbox-probe-contract.test.ts apps/api/test/http-security.test.ts test/integration/mcp-http.test.ts packages/contracts/test/contracts.test.ts`.
- Reviewer concerns fixed: probe sessions are factory-scoped across HTTP requests, and the widget sends one follow-up for each new request id without exposing the private capability.
- Existing public endpoint `https://cloud-harness-mcp.46-250-239-227.sslip.io` is healthy (`/healthz`, `/readyz`) but returns 404 for `/mcp-mailbox-probe`; it is not running this branch/probe code yet.
- Blocked before Phase 2 until an actual ChatGPT draft host mounts the resource and proves `sendFollowUpMessage()`, PiP persistence, widget-private metadata, and two autonomous submit turns.

## Success Criteria

- [ ] Resource/widget mounts on the actual ChatGPT draft host.
- [ ] Widget receives a delayed in-memory message through an app call.
- [ ] `sendFollowUpMessage()` creates two sequential turns without user gesture.
- [ ] Both turns call strict submit and the widget resumes polling.
- [ ] Widget-private capability is not visible to the model and is required server-side.
- [ ] Model discovery/dispatch excludes all mutating existing Cloud Harness operations.
- [ ] PiP/mount survives the bootstrap and two follow-up turns.
- [ ] Original Cloud Harness/WAB working trees remain unchanged.
- [ ] No durable mailbox schema, WAB provider, docs update, or VPS production-like stack is built before this gate passes.

## Risk Assessment

- **Host feature missing:** stop or classify semi-autonomous; do not compensate with Playwright.
- **Passive visibility only:** fail until private capability/server authorization is proven.
- **Probe contaminates public contract:** isolated feature-gated server/path and probe names; delete before final contract.
- **False success from one turn:** two sequential autonomous turns are mandatory.
- **Branch contamination:** clean worktree and exact remote/base checks before first commit.
