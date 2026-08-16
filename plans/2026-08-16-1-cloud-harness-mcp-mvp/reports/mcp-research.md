---
title: "MCP 2026-07-28 and TypeScript SDK v2 Research"
date: 2026-08-16T19:27:00+07:00
status: complete
scope: "Stateless Streamable HTTP remote coding-harness MCP server"
sources: "Official MCP specification/docs and modelcontextprotocol/typescript-sdk only"
---

# MCP 2026-07-28 and TypeScript SDK v2 Research

## Table of Contents

- [Executive Summary](#executive-summary)
- [Protocol Contract](#protocol-contract)
- [Recommended TypeScript Stack](#recommended-typescript-stack)
- [Dual-Era Compatibility](#dual-era-compatibility)
- [Recommended Tool Surface](#recommended-tool-surface)
- [Results, Schemas, and Annotations](#results-schemas-and-annotations)
- [Authorization and HTTP Security](#authorization-and-http-security)
- [Client and Conformance Testing](#client-and-conformance-testing)
- [Risks and Design Implications](#risks-and-design-implications)
- [Testable Acceptance Criteria](#testable-acceptance-criteria)
- [Official References](#official-references)
- [Unresolved Questions](#unresolved-questions)

## Executive Summary

Build on the stable TypeScript SDK v2 split packages, centered on `@modelcontextprotocol/server` and `createMcpHandler`. For Express/Node, add `@modelcontextprotocol/express` and `@modelcontextprotocol/node`; use `@modelcontextprotocol/client` only in tests and client tooling. Do not start a new project on the v1 monolithic `@modelcontextprotocol/sdk` API. SDK v2 implements protocol `2026-07-28`; v1 remains a maintenance line, not the target architecture ([SDK README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md)).

The critical 2026 change is genuinely stateless protocol traffic: no `initialize`/`initialized`, no `Mcp-Session-Id`, and one self-describing POST per request. `createMcpHandler(factory)` creates a fresh `McpServer` for every HTTP request and already serves 2025-era Streamable HTTP clients statelessly. Application continuity must use explicit, authorization-bound `workspaceId` and `operationId` handles in tool arguments, never hidden transport session state ([2026 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)).

For the MVP, expose seven composable tools: open/inspect/close a workspace, read/apply a file patch, and run/interact with a command. Return concise text plus schema-conforming `structuredContent`; use `isError: true` for recoverable tool failures. Authenticate every public request, validate bearer audience and scopes, enforce Host and Origin checks before MCP dispatch, and sandbox workspaces independently of MCP authorization.

## Research Methodology

- Researched: 2026-08-16.
- Recency target: protocol 2026-07-28 and SDK v2 stable line as of the research date.
- Inputs: repository README, license, MVP plan, and five phase stubs; all are placeholders except the product description.
- External boundary: only dated MCP specification/docs, official MCP blog, and official `modelcontextprotocol/typescript-sdk` repository/docs/security advisory.
- Evaluation: protocol compliance, stateless scaling, backward compatibility, agent usability, authorization, isolation, and mechanically testable behavior.

## Protocol Contract

### Modern request model

For protocol `2026-07-28`:

1. Expose one MCP endpoint, conventionally `POST /mcp`.
2. Each JSON-RPC request is a separate POST. Reply with one JSON object or a request-scoped SSE stream; clients must accept both.
3. Require `Accept: application/json, text/event-stream`.
4. Require `MCP-Protocol-Version` on every request and the matching `_meta["io.modelcontextprotocol/protocolVersion"]` in the body.
5. Require `Mcp-Method` on requests; also require `Mcp-Name` for `tools/call`, `resources/read`, and `prompts/get`. Reject header/body disagreement.
6. Carry client identity and capabilities in request `_meta`; there is no initialization handshake.
7. Do not emit `Mcp-Session-Id`. Do not depend on GET as a general notification stream. Request-local progress can use that POST's SSE response; long-lived change notifications use `subscriptions/listen`.
8. Treat an SSE disconnect as cancellation and stop work promptly.

These are direct requirements of the dated [Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). `server/discover` is mandatory on servers but optional for clients to call; unsupported versions return JSON-RPC error `-32022` with `supported` and `requested`, allowing client retry ([versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).

### State model

MCP transport statelessness does not mean the coding harness cannot retain workspaces or running processes. It means that state must be explicit:

```text
Bearer subject + workspaceId -> isolated workspace record
Bearer subject + operationId -> running/completed command record
```

Both handles must be opaque, high-entropy, expiry-bound, and checked against the authenticated subject/tenant on every call. Persist workspace/operation records in a store reachable by every replica, or route them through a backend service that is. A modern request may land on any replica; transport affinity is a protocol regression.

## Recommended TypeScript Stack

### Runtime dependencies

| Package | Exact role/API |
|---|---|
| `@modelcontextprotocol/server` | `McpServer`, `createMcpHandler`; tool/resource registration and web-standard handler |
| `@modelcontextprotocol/express` | `createMcpExpressApp`, `requireBearerAuth`; JSON parsing, Host/Origin guards, bearer middleware |
| `@modelcontextprotocol/node` | `toNodeHandler`; adapt the web-standard handler once to Express/Node |
| `express` | HTTP application and middleware composition |
| `zod` v4 | Standard Schema-compatible input/output schemas; import as `zod/v4` |

### Development/test dependency

| Package | Exact role/API |
|---|---|
| `@modelcontextprotocol/client` | Real SDK `Client` and Streamable HTTP client transport for protocol-level tests |

Install the v2 packages as one locked dependency set and commit the package-manager lockfile. Do not mix v1 `@modelcontextprotocol/sdk` server/transport classes with v2 split packages. The official package list and Standard Schema support are in the [SDK README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md); the official Express composition is in [Serve with Express](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/express.md).

### Recommended server shape

```ts
import { createMcpExpressApp, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(({ authInfo }) => {
  const server = new McpServer({ name: 'cloud-harness', version: '0.1.0' });

  server.registerTool(
    'workspace_status',
    {
      description: 'Inspect one authorized workspace and its current Git state.',
      inputSchema: z.object({ workspaceId: z.string() }),
      outputSchema: z.object({
        workspaceId: z.string(),
        branch: z.string().nullable(),
        dirty: z.boolean()
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ workspaceId }) => {
      const data = await inspectAuthorizedWorkspace(authInfo, workspaceId);
      return {
        content: [{ type: 'text', text: data.dirty ? 'Workspace has changes.' : 'Workspace is clean.' }],
        structuredContent: data
      };
    }
  );

  return server;
});

const app = createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: ['mcp.example.com'],
  allowedOrigins: ['trusted-host.example']
});
const authenticate = requireBearerAuth({ verifier });
const nodeHandler = toNodeHandler(handler);

app.all('/mcp', authenticate, (req, res) => void nodeHandler(req, res, req.body));
```

The factory must stay cheap and side-effect-free. Create reusable connection pools, telemetry, and immutable configuration once outside it; create request/caller-specific `McpServer` registrations inside it. The SDK explicitly warns that `createMcpHandler` itself validates neither headers nor tokens ([Serve over HTTP](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)).

Avoid manually constructing `NodeStreamableHTTPServerTransport` for the modern endpoint. That API remains useful for hand-wired, sessionful 2025-era deployments, but is not the v2 default. The per-request factory also avoids the cross-client response leak class documented in the official [SDK security advisory GHSA-345p-7cg4-v4c7](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7).

## Dual-Era Compatibility

| Era | Versions | Behavior | MVP decision |
|---|---|---|---|
| Modern | `2026-07-28`+ | Per-request metadata; no handshake/session; POST only for ordinary calls | Primary and required |
| Legacy Streamable HTTP | `2025-03-26` through `2025-11-25` | `initialize`, negotiated version, optional session/GET stream | Enable SDK v2's default stateless compatibility from the same factory |
| Legacy HTTP+SSE | `2024-11-05` | Separate SSE and message endpoints | Off by default; enable only for a named client requirement |

Use the SDK's `createMcpHandler` era dispatch instead of branching application code on raw headers. The factory receives `era` when unavoidable. Keep all tool implementations era-neutral and explicit-handle based. The official handler serves 2025-era clients statelessly by default; the separate legacy option covers the deprecated HTTP+SSE transport ([HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md), [legacy-client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md)).

Compatibility rules:

- Modern calls must work without `initialize`; reject a modern request that lacks/mismatches required metadata.
- Legacy calls must complete their handshake before tools are called.
- Never add a synthetic session to modern calls. Do not translate `Mcp-Session-Id` into a workspace.
- Advertise only versions actually covered by automated tests.
- On `UnsupportedProtocolVersionError`, clients may retry a mutually supported version from `supported`.
- Keep 2024 HTTP+SSE on isolated compatibility routes if later enabled. It is deprecated with a minimum twelve-month offramp, so it should not shape the core design ([2026 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)).

## Recommended Tool Surface

Seven tools are the smallest practical coding loop without collapsing authorization and annotations into ambiguous action multiplexers.

| Tool | Essential input | Structured output | Annotation intent |
|---|---|---|---|
| `workspace_open` | source descriptor/ref or approved template | `workspaceId`, normalized source/ref, expiry | non-read-only; non-idempotent; open-world |
| `workspace_status` | `workspaceId` | branch, HEAD, dirty paths, resource limits | read-only; idempotent; closed-world |
| `file_read` | `workspaceId`, relative path, line/byte window | path, text, range, truncated/next cursor | read-only; idempotent; closed-world |
| `file_apply_patch` | `workspaceId`, unified patch, optional expected HEAD/hash | changed paths, rejects, new hashes | destructive; non-idempotent; closed-world |
| `command_run` | `workspaceId`, command/argv, relative cwd, timeout | exit state, stdout/stderr chunk, `operationId` if active | destructive; non-idempotent; open-world |
| `command_io` | `workspaceId`, `operationId`, cursor, optional stdin/cancel | state, next output chunk/cursor, exit code | destructive; non-idempotent; closed-world |
| `workspace_close` | `workspaceId` | closed/already-closed, retained artifacts | destructive; idempotent; closed-world |

Design notes:

- `command_run` covers search (`rg`), Git inspection, tests, builds, and project-native utilities. A separate list/search tool is YAGNI for MVP.
- `command_io` unifies polling, bounded output paging, stdin, and cancellation. Require at least one requested action; bind every operation to its workspace and principal.
- All paths are workspace-relative. Resolve then verify containment, including symlinks/junctions, before access.
- `file_apply_patch` is the only direct mutation primitive. Reject patches outside the workspace and support an optimistic expected hash/HEAD to prevent stale writes.
- Sandbox command execution below the MCP layer: non-root runtime, filesystem boundary, CPU/memory/PID/time quotas, network policy, environment allowlist, and output limits. MCP bearer auth is not a sandbox.
- If cloning arbitrary URLs is not allowed, `workspace_open` should accept only a server-side approved source identifier. Do not let tool descriptions imply broader access than policy permits.

## Results, Schemas, and Annotations

Every tool should define both `inputSchema` and `outputSchema`. For success, return:

- `content`: one short model-readable summary. Never force the agent to parse prose for identifiers.
- `structuredContent`: all identifiers/state/cursors, conforming exactly to `outputSchema`.
- resource links only for durable, access-controlled large artifacts; do not inline unbounded logs/diffs.

For expected operational failures (nonzero command exit, patch conflict, expired handle, missing file), return a completed tool result with `isError: true`, a concise text explanation, and structured fields such as `code`, `retryable`, and `details`. Reserve JSON-RPC errors for malformed protocol requests, unknown methods/tools, invalid arguments rejected before execution, and server faults. This distinction lets an agent see and repair tool-level failures. The official tool contract requires structured results to conform to the advertised output schema and describes `isError` recovery behavior ([Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).

Use standard annotations accurately:

- `readOnlyHint`: no environment mutation.
- `destructiveHint`: may destroy or overwrite data.
- `idempotentHint`: repeating with identical arguments has no additional effect.
- `openWorldHint`: may interact beyond the local closed domain, such as network or arbitrary command execution.

Annotations are model/client hints, not access control. Enforce authorization and sandbox policy in handlers. Keep tool descriptions explicit about preconditions, side effects, timeouts, truncation, and returned handles. Use stable ASCII tool names because `Mcp-Name` is mirrored into an HTTP header; the protocol supports base64 sentinel encoding, but simple names avoid needless gateway complexity ([Streamable HTTP metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).

## Authorization and HTTP Security

### Required deployment controls

1. TLS at the public ingress. Do not expose bearer-authenticated MCP over plaintext Internet HTTP.
2. Validate `Host` and `Origin` before MCP dispatch. Invalid present Origin must return HTTP 403. Set explicit `allowedHosts` and `allowedOrigins` when binding `0.0.0.0`; the localhost defaults do not apply to a public bind.
3. Authenticate all `/mcp` methods with `requireBearerAuth({ verifier })`. The verifier must validate signature, expiry/not-before, issuer, and audience/resource; attach minimal `AuthInfo`.
4. Publish OAuth Protected Resource Metadata and return a standards-shaped `WWW-Authenticate: Bearer resource_metadata="..."` challenge on 401. The MCP server is the OAuth resource server; authorization-server implementation may be external.
5. Bind tokens to this MCP resource/audience. Never accept token passthrough to an upstream service and never reuse client credentials across authorization-server issuers.
6. Enforce least-privilege scopes in each tool handler, for example `workspace:read`, `workspace:write`, `command:run`, and `workspace:admin` for close/delete. Do not trust `Mcp-Method`, `Mcp-Name`, or tool annotations as the final authorization decision.
7. Never log Authorization headers, raw tokens, injected environment secrets, or unredacted command output. Apply output redaction and size caps before creating MCP content.
8. Rate-limit by authenticated principal plus method/tool, cap concurrent operations, and audit workspace lifecycle/mutations without storing secret contents.

OAuth support is optional in the abstract protocol but appropriate for this public remote server. The dated authorization spec defines OAuth 2.1/resource-server behavior, protected resource metadata, resource indicators, and least-privilege scope challenges ([Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)). Audience validation, secure token storage, HTTPS, PKCE for clients, and token-passthrough prohibition are explicit security requirements ([Authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)).

For an MVP used only by pre-registered machine clients, a configured JWT issuer plus resource-server metadata is simpler than embedding an authorization server. Do not implement Dynamic Client Registration in new code; it is deprecated in favor of Client ID Metadata Documents (CIMD) ([2026 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)).

## Client and Conformance Testing

Use three layers.

### 1. Handler/tool unit tests

- Construct `createMcpHandler(factory)` in process.
- Drive `handler.fetch` with a real v2 `Client` where supported by the official test utilities; use the SDK's in-memory transport for transport-independent tool registration/result tests.
- Inject deterministic auth/workspace stores; do not mock MCP wire shapes manually.
- Validate every success and error `structuredContent` against its advertised schema.

The SDK documents real-client, in-process testing in its [testing guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md).

### 2. HTTP transport tests

- Start the Express app on an ephemeral loopback port and connect with `@modelcontextprotocol/client`'s Streamable HTTP client transport.
- Exercise direct modern `tools/list` and `tools/call` without initialization.
- Inspect raw HTTP for required version/method/name headers, JSON and SSE acceptance, 202 cancellation, and 400/403/401/404 behavior.
- Deliberately mismatch header/body version, method, and name.
- Test JSON response and request-scoped SSE progress, including client disconnect cancellation.

### 3. Compatibility, replica, and adversarial tests

- Run the same suite for `2026-07-28` and each advertised 2025-era version.
- Send consecutive calls to alternating app replicas. Only explicit `workspaceId`/`operationId` may preserve application state.
- Run two authenticated clients concurrently and assert no response, progress event, workspace, or operation crosses principals.
- Test invalid Origin/Host, missing token, wrong issuer/audience, expired token, insufficient scope, traversal, symlink escape, output flood, timeout, cancellation, and guessed/foreign handles.
- If 2024 HTTP+SSE is enabled, give its separate routes a dedicated legacy suite and deprecation telemetry.

## Risks and Design Implications

| Risk | Consequence | Mitigation/decision |
|---|---|---|
| Reusing `McpServer` or transport instances | Cross-client response/progress leakage | `createMcpHandler` factory; fresh server per request; concurrency regression test |
| Treating modern MCP as sessionful | Load-balancer affinity, broken replicas, spec noncompliance | Explicit workspace/operation handles; shared backing service/store |
| Mixing SDK v1 and v2 examples | Wrong imports, handshake/session assumptions | Only split v2 packages in production; lockfile and import lint/review |
| Enabling 2024 HTTP+SSE by default | Extra attack/maintenance surface for deprecated transport | Off unless a named client requires it; isolated routes/tests |
| Trusting annotations/headers for policy | Unauthorized destructive execution | Handler-level subject, scope, workspace, and command policy checks |
| Unbounded command output/processes | Memory/connection exhaustion | Chunk cursors, caps, timeout, quotas, cancellation, operation expiry |
| Returning secrets in model-visible content | Credential/data exfiltration | Minimal environment, redaction, no token logs, artifact ACLs |
| Workspace handle theft/guessing | Cross-tenant code access | High-entropy opaque IDs, subject binding, expiry, audit, no sequential IDs |
| Side effects in per-request server factory | Duplicate expensive resources or behavior | Module-level pools; request factory registers thin handlers only |
| SSE buffering at proxy | Delayed progress/false timeouts | `X-Accel-Buffering: no`, proxy streaming config; prefer JSON unless progress is needed |

## Testable Acceptance Criteria

### Protocol and SDK

- [ ] Runtime uses only v2 split MCP packages; no production import from `@modelcontextprotocol/sdk`.
- [ ] `/mcp` serves direct `2026-07-28` `tools/list`/`tools/call` without `initialize` and emits no `Mcp-Session-Id`.
- [ ] Valid modern requests include matching body/header protocol version and correct `Mcp-Method`/`Mcp-Name`.
- [ ] Header/body mismatch returns HTTP 400 with `HeaderMismatch`; unsupported version returns HTTP 400 and JSON-RPC `-32022` with supported versions.
- [ ] A fresh `McpServer` is created per HTTP request; a parallel two-client test proves no response/progress cross-talk.
- [ ] Modern calls succeed while round-robin alternating between two stateless app replicas.

### Tools

- [ ] The seven-tool surface is listed with descriptions, input/output schemas, and truthful annotations.
- [ ] Every success returns concise `content` and schema-valid `structuredContent` containing all handles/cursors.
- [ ] Expected tool failures set `isError: true` with stable error code and retryability; protocol faults remain JSON-RPC errors.
- [ ] All paths remain inside the bound workspace after normalization and symlink/junction resolution.
- [ ] Commands enforce cwd, environment, network, CPU, memory, PID, output, and wall-time policy.
- [ ] Long-running commands return an authorization-bound `operationId`; output is cursor-paged and cancellation stops the underlying process.

### Security

- [ ] Public ingress uses HTTPS and explicit allowed Host/Origin configuration.
- [ ] Invalid present Origin and invalid Host return 403 before the MCP handler; absent/invalid bearer token returns a proper 401 challenge.
- [ ] Wrong issuer, audience/resource, expiry, or subject-bound handle is rejected; insufficient scope cannot invoke the tool.
- [ ] Logs and MCP results contain no Authorization header, token, injected secret, or known secret fixture.
- [ ] Workspace/operation IDs are opaque, expire, and cannot be used by another authenticated principal.

### Compatibility

- [ ] Automated tests cover every advertised protocol version.
- [ ] A 2025-era client completes initialization and invokes the same tool implementations through SDK compatibility handling.
- [ ] 2024 HTTP+SSE is disabled, or has an explicitly approved client, isolated routes, its own tests, and deprecation telemetry.
- [ ] Server shutdown awaits `handler.close()` and terminates/records owned operations according to the workspace retention policy.

## Actionable Next Steps

1. Lock the latest compatible v2 releases of `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, and test-only `@modelcontextprotocol/client` together.
2. Implement the per-request factory and security middleware before tool business logic.
3. Define shared `WorkspaceStore`/`OperationStore` contracts with subject binding and expiry.
4. Implement `workspace_status` and `file_read` first, then mutation/command tools with sandbox enforcement.
5. Add the modern protocol/header/auth negative suite before enabling any legacy era.
6. Decide the exact issuer/resource URI and whether any named consumer requires 2024 HTTP+SSE.

## Official References

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [TypeScript SDK v2 README/package map](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md)
- [SDK v2: serve over HTTP](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
- [SDK v2: Express](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/express.md)
- [SDK v2: sessions, state, and scaling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md)
- [SDK v2: support legacy clients](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md)
- [SDK v2: testing](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md)
- [Official SDK cross-client leak advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7)

## Unresolved Questions

1. Which OAuth issuer and canonical MCP resource URI will production use?
2. Is workspace state ephemeral per requestor, retained across reconnects, or backed by a durable volume/object store?
3. Which outbound network destinations and command families are allowed in the execution sandbox?
4. Does a named target client require deprecated 2024-11-05 HTTP+SSE, or can MVP support only modern plus 2025-era Streamable HTTP?
