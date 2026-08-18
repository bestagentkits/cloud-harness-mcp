---
phase: 2
title: "Pi SDK worker and model gateway"
status: pending
priority: P1
effort: "2-3d"
dependencies: [1]
---

# Phase 2: Pi SDK worker and model gateway

## Overview

Build the isolated Pi runtime and fixed provider gateway. Pi receives only one job protocol and explicit custom tools; repository operations remain inside the existing network-disabled executor.

## Requirements

- Pin `@earendil-works/pi-coding-agent@0.84.2` exactly to npm `gitHead` `914cf1472e715297caa30db4b9535d534a9eb718` and published integrity in the lockfile; record MIT attribution where the dependency/image inventory already belongs.
- Create a small agent-runtime package with strict LF-delimited JSONL framing, bounded queues/messages, request IDs, and schemas for start, tool request/response/cancel, event, message, gateway lease, usage, and terminal records.
- Instantiate `AgentSession` with in-memory session/settings, controlled resource loading, `noTools: "all"`, `tools: proxyToolNames`, matching custom proxy definitions, and no project/global extensions, prompts, skills, auth files, or context discovery. Assert the exact active tool-name set.
- Propagate each custom tool's `AbortSignal` into request-ID-scoped protocol cancellation; bound tool updates and Pi events before serialization. Never emit hidden thinking, provider headers, credentials, or unredacted errors.
- Create a non-root read-only agent image with no workspace/host mounts, dropped capabilities, `no-new-privileges`, PID/CPU/memory/nofile limits, bounded tmpfs, and one unique internal model network per agent. The worker has no route to peer agents, control services, metadata, or general Internet.
- Create a model gateway with no host port, repository/job/state/Docker mounts, or runner/API/control network. It joins each bounded agent network on demand plus a dedicated `provider-egress` network, accepts only a one-use agent/profile lease, forwards to one configured validated HTTPS upstream/profile, injects the credential from an exact gateway-only file mount, caps request/response sizes/deadlines, and logs no body/header secrets. Treat the gateway as a trusted egress broker; do not claim its own process is a hostile sandbox.
- Keep gateway environment/secret files service-specific; narrow the production runner secret mount to its exact GitHub key file. The worker receives only an internal base URL and revocable lease. Before each provider request, the gateway reserves remaining token/cost budget, clamps maximum output tokens, reconciles actual streamed usage, aborts upstream on downstream close/explicit cancel, and confirms drain before lease revocation completes.

## Architecture

The runner launches one deterministic, labeled agent container, creates its unique internal model network, connects the gateway to that network, and speaks the job/tool protocol over stdin/stdout. Custom tools call back through that channel; AgentManager maps only `AgentProxyOperationSchema` values to the existing validated workspace worker. The gateway alone joins the distinct routable `provider-egress` network; neither gateway nor agent joins `runner-egress` or `control`.

This keeps Pi outside the rootful runner process and outside the general workspace executor. It avoids a second checkout writer, provider credentials in repository-controlled command space, shared worker networks, and control-service reachability.

## Related code files

- Create: `apps/agent-runtime/` with protocol, controlled Pi session, redaction, and worker entrypoint
- Create: `apps/model-gateway/` with fixed-profile streaming proxy and request guards
- Create: `docker/agent.Dockerfile`, `docker/model-gateway.Dockerfile`
- Modify: root/workspace package manifests and lockfile, `compose.yaml`, `compose.production.yaml`, `scripts/verify-compose-boundaries.mjs`
- Test: focused agent-runtime/model-gateway unit tests, per-agent network cleanup tests, and Compose boundary tests

## TDD implementation steps

1. Add protocol parser tests for chunked records, invalid JSON/UTF-8, U+2028/U+2029, oversized records, queue overflow, duplicate terminal records, and closed-channel writes.
2. Add controlled-session tests proving built-ins/resources/extensions are absent and the exact `tools: proxyToolNames` set alone can execute.
3. Add fake AgentSession lifecycle tests for prompt, event streaming, steer/follow-up, cooperative abort, request-ID tool cancellation, hard deadline handoff, usage accounting, and redaction.
4. Add gateway tests for profile/lease mismatch, replay, path escape, hostile headers, private/custom production upstream rejection, pre-request budget clamp, stream/output bounds, downstream disconnect, explicit cancellation, upstream drain, and credential non-disclosure.
5. Implement runtime, gateway, both Dockerfiles, unique per-agent networks, dedicated `provider-egress`, exact secret mounts, and cleanup/reconciliation.
6. Extend Compose verification so only ingress remains host-published; gateway alone has dedicated provider egress; agent workers have neither control/runner networks nor direct egress; gateway/runner/API mounts and environments are mutually least-privilege.

## Success criteria

- [x] Agent runtime starts and completes against a test-only TLS fake provider container on an isolated test topology, with a trusted test CA/profile that cannot enable private production origins.
- [x] Pi cannot discover or execute default tools, project resources, extensions, local auth/session files, or any custom tool outside the exact explicit allowlist.
- [x] Each agent container has no repository/control/provider secret mount, Docker socket, host path, peer-agent route, control network, or direct Internet route; its unique network is removed during normal and restart cleanup.
- [x] Gateway rejects every unconfigured target/profile/lease, uses only exact service-specific credentials, and never returns/logs them.
- [x] Cancel or hard-kill aborts and drains model/gateway and request-scoped tool work before the single terminal event is accepted.
- [x] Pi/package/runtime versions are exact and reproducible from the lockfile.

## Risk assessment

The gateway is a new credential boundary. Keep it protocol-thin, profile-fixed, non-publishing, body-blind in logs, and independently resource-bounded. If a Pi provider API cannot be represented through the fixed gateway without weakening destination enforcement, reject that profile instead of adding generic proxying.
