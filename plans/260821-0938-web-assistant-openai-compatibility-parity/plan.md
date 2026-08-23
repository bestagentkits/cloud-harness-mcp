---
title: "Web Assistant OpenAI Compatibility Parity"
description: "Port CatGPT-Gateway behavior into the durable web-assistant-browser core, omitting only the TUI, then refine compatibility and security after parity."
status: in-progress
priority: P1
effort: "18-30d"
tags: [openai-compatibility, browser-gateway, parity-port, xia]
blockedBy: [260823-0614-chatgpt-mailbox-runtime-mvp]
created: 2026-08-21
sourceRepo: "GautamVhavle/CatGPT-Gateway"
sourceCommit: "b203223ea41521b2309bb370e491354a8aaee3ec"
---

# Web Assistant OpenAI Compatibility Parity

## Overview

Replicate the externally visible API, browser-provider, multimodal, image, tool-calling, thread, provider, and VPS behavior of CatGPT-Gateway on top of `web-assistant-browser`'s existing principal-owned durable run core. Deliver source behavior parity first. Refine security, semantics, streaming, and operations only after the parity gates pass. The TUI is the only explicitly omitted source feature.

Authoritative comparison: [`../260821-web-assistant-browser/reports/xia-catgpt-gateway-openai-compatibility.md`](../260821-web-assistant-browser/reports/xia-catgpt-gateway-openai-compatibility.md).

## User Decisions

- Port source behavior first; optimize/refine afterward.
- Do not silently cut source capabilities.
- Omit TUI.
- Include OpenAI Chat Completions, Responses, models, prompt-based JSON tool calls, multimodal/file input, image generation, custom thread/status routes, Claude, MiniMax, Xvfb/noVNC runtime, completion fallbacks, selector fallbacks, diagnostics, and live compatibility scripts.
- Preserve the local durable/auth/encryption core unless it prevents parity.
- Keep native ChatGPT UI evidence distinct from model-authored OpenAI function calls.
- Public ingress exposes only required OpenAI-compatible and authenticated artifact endpoints.
- Native `/v1/chat`, `/v1/runs/*`, custom source `/chat`/thread/status routes, readiness, diagnostics, and raw durable events remain loopback/admin-only for execution support and debugging.

## Goals

| # | Goal | Priority |
|---|---|---|
| 1 | OpenAI SDK-compatible `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and `/v1/images/generations` | P1 |
| 2 | Caller-registered function tools using session envelopes, Codex-style JSONL, and correlated outputs | P1 |
| 3 | Source-compatible vision, file attachments, generated image/file handling | P1 |
| 4 | Source-compatible custom chat/thread/status routes and ChatGPT/Claude/MiniMax providers | P1 |
| 5 | Source-compatible headed browser/Xvfb/noVNC runtime and diagnostics | P1 |
| 6 | Preserve local principals, encryption, idempotency, queueing, cancellation, replay, and recovery | P1 |
| 7 | Validate with OpenAI Python/JS SDK, LangChain, Responses/Codex patterns, live browser, and VPS smokes | P1 |

## Non-goals

- TUI.
- Claiming stronger OpenAI semantic fidelity than either implementation actually provides during the parity pass.
- Removing the native `/v1/chat` and durable event API.
- Modifying Cloud Harness source or deployment.

## Architecture

```text
OpenAI / source-compatible clients
              |
              v
Fastify compatibility routes
  | models | chat completions | responses | images | custom threads |
              |
              v
Compatibility normalization and prompt construction
              |
              v
Provider router
  | ChatGPT browser | Claude browser | MiniMax HTTP |
              |
              v
Existing RunService / queue / BrowserLease / encrypted SQLite
              |
              +--> native durable events
              +--> OpenAI response/SSE projectors
              +--> artifact store
```

## Phases

| # | Phase | Status | Dependencies |
|---|---|---|---|
| 1 | [Parity Baseline And Contracts](./phase-01-start.md) | Completed | Existing Phase 2/3 commits |
| 2 | [Chat Completions And Models](./phase-02-chat-completions-and-models.md) | Completed | 1 |
| 3 | [Tool Calling](./phase-03-tool-calling.md) | Completed | 2 |
| 4 | [Responses API](./phase-04-responses-api.md) | Completed | 2, 3 |
| 5 | [Multimodal Inputs And Uploads](./phase-05-multimodal-inputs-and-uploads.md) | Completed | 2, 3 |
| 6 | [Images And Artifact Delivery](./phase-06-images-and-artifact-delivery.md) | Completed | 5 |
| 7 | [Thread And Provider Parity](./phase-07-thread-and-provider-parity.md) | Completed | 2, 3, 5 |
| 8 | [Browser Runtime And VPS Parity](./phase-08-browser-runtime-and-vps-parity.md) | Completed | 2-7 |
| 9 | [Compatibility Validation And Rollout](./phase-09-compatibility-validation-and-rollout.md) | Pending | 1-8 |

## Cross-cutting Contracts

- Compatibility routes are additive; native routes remain the internal durable execution/control plane.
- Public ingress allowlists only required OpenAI-compatible and authenticated artifact endpoints.
- Native `/v1/chat`, `/v1/runs/*`, custom source routes, health/readiness, and diagnostics are private.
- Every browser request uses the existing single `RunService`/`BrowserLease`; no second page lock.
- Original OpenAI items and transformed browser prompts are stored separately and encrypted.
- `chatgpt_ui` and `model_json` tool evidence never share semantics.
- Tool registration is scoped to the principal-owned browser session. The exact caller system instructions, registered tools, schemas, and caller-supplied tool-choice rule are synchronized into fingerprinted ChatGPT Custom Instructions; browser turns carry only user or correlated function-output payloads.
- Agent function requests and final messages use Codex-style JSONL items. Caller results use correlated `function_call_output` wrappers.
- Unknown names and invalid arguments are corrected from the registered catalog before an OpenAI tool call is accepted.
- Ambiguous browser submission never auto-resubmits.
- Source-compatible weak behavior may be enabled behind compatibility configuration, but must not silently disable local ownership/encryption.
- Every compatibility limitation is covered by an executable contract test and documented in the model/endpoint capability matrix.

## Success Criteria

- [x] OpenAI Python and JavaScript SDKs can list models and perform non-stream Chat Completions.
- [x] Source-compatible Chat Completions `stream=true` behavior is reproduced, then later refinement is gated separately.
- [x] LangChain caller tool flow produces validated OpenAI `tool_calls` and accepts correlated outputs.
- [x] Responses non-stream and buffered SSE work with Codex-style request/response shapes.
- [x] Vision/file attachments upload through the current ChatGPT composer.
- [x] Image generation returns `b64_json` and source-compatible URL behavior.
- [x] Custom chat/thread/status routes match source behavior.
- [x] ChatGPT, Claude, and MiniMax provider selection works.
- [x] Headed Xvfb/noVNC production runtime retains one browser/profile/controller.
- [ ] Source live scripts are ported or replaced with equivalent executable tests.
- [x] Existing native run/auth/encryption/recovery suite remains green.
- [ ] TUI is the only source capability intentionally omitted.

## Rollback

Each phase is additive and independently feature-gated. Disable compatibility routes/providers/artifacts without removing native routes or browser profile state. Use versioned migrations and phase-specific commits. VPS rollback removes only the compatibility service route/container and restores the prior independent-service release.

<!-- slug: web-assistant-openai-compatibility-parity -->
