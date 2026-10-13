# Phase 3: Meta-Tool Surface and `/mcp-gateway` Endpoint

## Context Links
- Plan: `plans/260914-0414-mcp-gateway/plan.md`
- API: `apps/api/src/mcp-gateway/service.ts` (new), `apps/api/src/mcp-gateway/meta-tools.ts` (new), `apps/api/src/mcp-gateway/index.ts` (new), `apps/api/src/mcp-server.ts`, `apps/api/src/app.ts`
- Edge: `deploy/nginx/cloud-harness-mcp.conf`, `deploy/scripts/upgrade-nginx-dashboard.sh`, `test/upgrade-nginx-routes.test.ts`, `scripts/verify-compose-boundaries.mjs`
- Tests: `apps/api/test/mcp-gateway-service.test.ts` (new), `apps/api/test/mcp-gateway-endpoint.test.ts` (new)

## Requirements
- A new composition root at `/mcp-gateway` reuses the existing inbound security chain (Host/Origin validation, pre-auth limits, `bearerAuth`, principal limits, JSON body limit, `toNodeHandler`).
- `tools/list` on that endpoint returns **exactly five** tools: `search`, `inspect`, `execute`, `permissions`, `status`.
- `execute` re-checks permission at execution time, resolves credentials only for an allowed tool, routes to the correct downstream server/tool, enforces a timeout, and never retries.
- `search`/`inspect` never advertise a tool the caller cannot use, and the runner — not the API — is the single source of truth for that decision.
- `status` tolerates a broken downstream server and never affects the health of other servers.
- Every meta-tool call produces a trace in the runner without transferring the whole fleet per call.
- The existing `/mcp` endpoint is untouched: it still lists exactly `TOOL_SPECS.length` tools.
- The endpoint is reachable through the real deployment edge.

## Interfaces to freeze (do not deviate)

```text
class McpGatewayService {
  constructor(runner: RunnerClient, connections: GatewayConnectionManager, options: {
    timeoutMs: number; maxResponseBytes: number; maxToolsPerServer: number;
    maxSchemaBytes: number; maxCatalogBytes: number; catalogTtlMs?: number;
  })
  search(principal, input: { query: string; server?: string; limit: number }, context: { signal?: AbortSignal; clientId?: string }): Promise<ToolResult>
  inspect(principal, input: { tool: string }, context): Promise<ToolResult>
  execute(principal, input: { tool: string; arguments: Record<string, unknown> }, context): Promise<ToolResult>
  permissions(principal, input: { tool?: string; server?: string }, context): Promise<ToolResult>
  status(principal, context): Promise<ToolResult>
  refreshServer(principal, serverId: string, context): Promise<ToolResult>
  testServer(principal, serverId: string, context): Promise<ToolResult>
  invalidateCatalog(principal): void
  close(): Promise<void>
}
createMcpGateway(config: ApiConfig, runnerClient: RunnerClient, overrides?: { fetchImpl?: FetchLike }): { factory: (context: McpRequestContext) => McpServer; service: McpGatewayService }
createApiApp(config: ApiConfig, overrides?: { runnerClient?: RunnerClient; gatewayFetchImpl?: FetchLike }): ApiRuntime
registerGatewayTools(server: McpServer, service: McpGatewayService, principal: RunnerPrincipalSelector): void
```

`createMcpGateway` **must take the existing `RunnerClient`**; it cannot be derived from `config`.
`createApiApp`'s `overrides` parameter exists so tests can inject a fake runner and a fake
downstream fetch; it is documented as test-only and defaults to today's behaviour exactly.

## Tasks & Steps

### Task 3.1 — Gateway service (write the test first)
- **Goal:** one service owns the meta-tool behaviour, trace recording, and downstream routing.
- **Target files and symbols:** create `apps/api/src/mcp-gateway/service.ts`; create `apps/api/test/mcp-gateway-service.test.ts`.
- **Steps:**
  1. Add a private `loadCatalog(principal, filter, signal)` calling `runner.callInternal('mcp_gateway_catalog', filter, principal, signal)` — **always with a filter** when only one tool or one server is needed, so `inspect`/`execute` never pull the fleet. Convert a non-`ok` result into a `HarnessError` carrying the upstream code.
  2. Add a per-principal short-TTL catalog cache (`catalogTtlMs`, default 5_000) keyed by principal + filter, plus `invalidateCatalog(principal)`. `execute` uses a cache entry keyed by `{ qualifiedName }`; `search` uses `{}`. Cache values may contain tool metadata but **never** resolved credentials.
  3. Enforce `maxCatalogBytes` via `estimateCatalogBytes` before selecting search candidates.
  4. Add a private `trace(principal, entry)` calling `runner.callInternal('mcp_gateway_trace_append', entry, principal)` that **swallows** a failed trace write; never include arguments or results.
  5. `search`: load `{}`, `filterSearchable`, `searchTools`, return `ok` with `{ results: [{ tool: qualifiedName, server, description, score }] }`. An unknown `server` filter yields an empty result, not an error.
  6. `inspect`: load `{ qualifiedName: tool }`. Unknown tool → `HarnessError('NOT_FOUND', 'unknown or inaccessible MCP tool', 404, false)` — the same message for unknown and forbidden, so existence is not leaked. Return `{ name, server, description, inputSchema, annotations, permission, availability }` with `inputSchema` copied verbatim.
  7. `execute`:
     - Validate the qualified name and load `{ qualifiedName: tool }`; unknown → the same 404 as `inspect`.
     - Resolve the server; disabled → `HarnessError('FORBIDDEN', 'MCP server is disabled', 403, false)`.
     - If the tool view's `availability` is `unavailable` → `HarnessError('INVALID_INPUT', 'tool is unavailable', 400, false)`.
     - Call `runner.callInternal('mcp_server_get_credentials', { serverId, toolName: tool.upstreamName, purpose: 'execute' }, principal, signal)`. If `data.allowed !== true`, record a `denied` trace and return a denied envelope — do **not** call downstream and do **not** include header values.
     - Call `connections.withConnection(server, data.headers, (client) => client.callTool({ name: tool.upstreamName, arguments }, { timeout: this.timeoutMs, signal }), signal)` exactly once.
     - Normalize into the existing `ToolResult` envelope: `ok: !result.isError`, `message` a short summary, `data: { content: result.content, structuredContent: result.structuredContent, isError: Boolean(result.isError) }`. Preserve `structuredContent` unchanged.
     - Record a `success` or `error` trace with `durationMs`, `requestBytes`, `responseBytes`, and a sanitized error. **Never retry.**
  8. `permissions`: with `tool` → `{ tool, allowed }`; with `server` → `{ server, permissionDefault, tools: [{ name, permission }] }`; with neither → `{ servers: [{ name, permissionDefault }] }`. Only effective decisions; never raw policy internals or another principal's data.
  9. `status`: `{ servers: [{ server, enabled, connection, toolCount, lastConnectedAt, lastCheckedAt, error }] }` where `connection` reconciles the runner-persisted status with `connections.health(serverId)`; `error` is the stored sanitized message.
  10. `refreshServer` / `testServer`:
      - Load the server and its cached tools (`listTools` on the connection is the discovery source).
      - Resolve credentials with **`purpose: 'connect'`**, which is the explicit server-level grant and therefore works for a deny-by-default server and for a brand-new server with no cached tools. This is not the `execute` gate and must never be used on the `execute` path.
      - On success: `listTools()`, `normalizeUpstreamTools(..., { maxTools: maxToolsPerServer, maxSchemaBytes })`, then `mcp_server_replace_tools`.
      - On failure: `mcp_server_connection_result` with `status: 'error'` and the sanitized message.
      - `testServer` additionally returns `{ status, toolCount, error }` for the dashboard and never returns headers or upstream bodies.
  11. `invalidateCatalog(principal)` is called after any successful registry mutation; the caller (Phase 4 BFF) also calls `connections.invalidate(serverId)`.
  12. `close()` → `connections.closeAll()`.
- **Success criteria:** the service routes, denies, traces, and scopes credentials correctly against a fake runner and fake connection manager.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-service.test.ts` exits 0.

### Task 3.2 — Meta-tool registration
- **Goal:** the five meta-tools are registered as zod-schema tools and return the shared result envelope.
- **Target files and symbols:** create `apps/api/src/mcp-gateway/meta-tools.ts`; edit `apps/api/src/mcp-server.ts` to export `resultToMcp`.
- **Steps:**
  1. Export `resultToMcp` from `apps/api/src/mcp-server.ts` (change `function resultToMcp` to `export function resultToMcp`).
  2. In `meta-tools.ts` implement `registerGatewayTools(server, service, principal)` with `server.registerTool(name, { title, description, inputSchema: z.object({...}), outputSchema: ToolResultSchema, annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } }, handler)`.
  3. Schemas and annotations:
     - `search` — `{ query: z.string().trim().min(1).max(512), server: z.string().trim().min(1).max(63).optional(), limit: z.number().int().min(1).max(25).default(5) }`; `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.
     - `inspect` — `{ tool: McpGatewayQualifiedToolNameSchema }`; read-only.
     - `execute` — `{ tool: McpGatewayQualifiedToolNameSchema, arguments: z.record(z.string(), z.unknown()).default({}) }`; `readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true`.
     - `permissions` — `{ tool: McpGatewayQualifiedToolNameSchema.optional(), server: z.string().trim().min(1).max(63).optional() }`; read-only.
     - `status` — `z.object({})`; read-only.
  4. Descriptions teach the progressive-disclosure workflow in one sentence each, e.g. `search`: "Find an MCP tool by describing what you need. Returns qualified tool names; call `inspect` for the schema and `execute` to run it."
  5. Each handler passes `context.mcpReq.signal` plus a client identity string derived from `context.authInfo?.clientId` where available.
- **Success criteria:** `createMcpGateway(...)` lists exactly five tools with the expected names.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-endpoint.test.ts` exits 0.

### Task 3.3 — Gateway composition root and app seam
- **Goal:** the gateway is assembled once per API process, served at `/mcp-gateway`, and testable without a live runner.
- **Target files and symbols:** create `apps/api/src/mcp-gateway/index.ts`; edit `apps/api/src/app.ts`.
- **Steps:**
  1. `index.ts` exports `createMcpGateway(config, runnerClient, overrides?)` returning `{ factory, service }`:
     - builds the `GatewayConnectionManager` from the config bounds plus `overrides?.fetchImpl`;
     - builds `new McpGatewayService(runnerClient, connections, { timeoutMs, maxResponseBytes, maxToolsPerServer, maxSchemaBytes, maxCatalogBytes })`;
     - `factory: (context) => new McpServer({ name: 'cloud-harness-mcp-gateway', version: serverVersion }, { instructions })` (import `serverVersion` from `../version.js` — `mcp-server.ts` hardcodes a stale literal; do not copy that) then `registerGatewayTools(...)`. Instructions explain search → inspect → execute, that only a small stable tool set is exposed, and that permissions are enforced server-side.
  2. In `apps/api/src/app.ts`, change the signature to `createApiApp(config: ApiConfig, overrides: { runnerClient?: RunnerClient; gatewayFetchImpl?: FetchLike } = {})`, use `const runnerClient = overrides.runnerClient ?? new RunnerClient(config)`, build `const gateway = createMcpGateway(config, runnerClient, { fetchImpl: overrides.gatewayFetchImpl })`, and keep `return { app, close, runnerClient }` plus a new `gateway` field on `ApiRuntime` for tests.
  3. Build a second handler: `const gatewayHandler = createMcpHandler(gateway.factory, { legacy: 'stateless', responseMode: 'auto' })` with `toNodeHandler`.
  4. Mount, mirroring the `/mcp` chain exactly:
     ```ts
     app.use('/mcp-gateway', requestSecurity(config), preAuthRequestLimits(), bearerAuth(config), principalRequestLimits());
     app.use('/mcp-gateway', express.json({ limit: config.maxBodyBytes, strict: true }));
     app.all('/mcp-gateway', async (request, response) => { /* application/json guard, then nodeHandler */ });
     ```
     Express `app.use('/mcp', ...)` does not match `/mcp-gateway` (the next character must be `/` or end), so the two chains cannot interfere.
  5. Extend `ApiRuntime.close` to `await Promise.all([handler.close(), gatewayHandler.close(), gateway.service.close()])`, and wrap the shutdown call in `apps/api/src/index.ts` so a close rejection cannot skip `process.exit`.
- **Success criteria:** the API boots, `/mcp-gateway` answers `initialize`/`tools/list`, and `/mcp` still lists the full harness surface.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-endpoint.test.ts apps/api/test/dashboard-app-mount.test.ts` exits 0.

### Task 3.4 — Endpoint tests, including the end-to-end credential-boundary test
- **Goal:** the endpoint contract, progressive disclosure, permission enforcement, credential scoping, rebinding defence, timeouts, and non-regression of `/mcp` are covered.
- **Target files and symbols:** create `apps/api/test/mcp-gateway-endpoint.test.ts`.
- **Steps:**
  1. Build the app with `createApiApp(config, { runnerClient: fakeRunner, gatewayFetchImpl: fakeDownstreamFetch })` — the seam from Task 3.3. `fakeRunner.callInternal` is a `vi.fn` serving a fake catalog and credential resolution; `fakeDownstreamFetch` is an in-process MCP Streamable HTTP responder. No real network, no live runner.
  2. Connect with `new Client({ name: 'gateway-test', version: '1.0.0' })` and `new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: 'Bearer test' } } })`, following `test/integration/mcp-http.test.ts:43-56`. This client talks to the app over loopback; the gateway's own downstream fetch is the injected fake, so the two do not collide.
  3. Assert `listTools()` returns exactly `['execute', 'inspect', 'permissions', 'search', 'status']` sorted — and that it is unchanged with 500 fake downstream tools present.
  4. Assert `search` returns a PostHog tool for `"website analytics traffic"` and excludes a tool on a disabled server.
  5. Assert `inspect` returns `structuredContent.data.inputSchema` deep-equal to the upstream schema fixture.
  6. **End-to-end credential boundary test (the highest-value test):** with a fake downstream and a distinctive secret value, assert in one flow:
     - the fake downstream received `tools/call` with `Authorization: Bearer <exact value>` and the caller's `arguments` byte-identical;
     - the MCP client result contains no secret value;
     - `JSON.stringify` of every trace row the fake runner recorded contains no secret value;
     - the credential header was absent from a discovery-path request the fake downstream observed.
  7. Assert `execute` on a `deny` tool returns a denied envelope and the fake downstream observed **zero** `tools/call` requests.
  8. **Rebinding test:** configure a resolver that returns a public address during validation and a private one during the transport lookup; assert the fake downstream observed **zero** requests carrying the credential.
  9. Assert a downstream `tools/call` error is normalized to a non-throwing MCP result with `isError: true` and a sanitized message.
  10. Assert a downstream `tools/call` that hangs yields a `TIMEOUT` result within roughly the configured timeout.
  11. Assert `/mcp` still lists `TOOL_SPECS.length` tools (regression guard).
- **Success criteria:** the suite passes offline; the meta-tool list is constant at 5 with 500 downstream tools; the credential reaches exactly one request and no trace.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-endpoint.test.ts` exits 0.

### Task 3.5 — Expose `/mcp-gateway` through the deployment edge (mandatory, not conditional)
- **Goal:** the new endpoint is reachable in a real deployment, not only from a direct API request.
- **Why this is load-bearing:** `deploy/nginx/cloud-harness-mcp.conf` enumerates every path with an exact `location` block (lines 8-56) and has no catch-all, so an unlisted `/mcp-gateway` returns nginx's 404 while every in-process test passes. `deploy/scripts/upgrade-nginx-dashboard.sh` materializes those blocks on every release and only knows `/mcp-api-key` and `/dashboard`. `deploy/ingress-proxy.mjs` is a path-agnostic byte proxy and needs no change.
- **Target files and symbols:** `deploy/nginx/cloud-harness-mcp.conf`, `deploy/scripts/upgrade-nginx-dashboard.sh`, `test/upgrade-nginx-routes.test.ts`, `scripts/verify-compose-boundaries.mjs`.
- **Steps:**
  1. Add to `deploy/nginx/cloud-harness-mcp.conf`, immediately after the `/mcp` block (line 31), the same streaming block pointed at the new upstream path:
     ```nginx
     location = /mcp-gateway {
         proxy_pass http://127.0.0.1:3100/mcp-gateway;
         proxy_http_version 1.1;
         proxy_set_header Host $host;
         proxy_set_header X-Forwarded-Proto $scheme;
         proxy_set_header Connection "";
         proxy_buffering off;
         proxy_request_buffering off;
         proxy_cache off;
         proxy_read_timeout 3600s;
         add_header X-Accel-Buffering no always;
     }
     ```
  2. Extend `deploy/scripts/upgrade-nginx-dashboard.sh`, mirroring the API-key route exactly: a `gateway_count`/`gateway_block`/`expected_gateway` triple, a `gateway_installed` flag included in the early-return condition, a matching "not the managed shape; refusing to overwrite it" refusal branch with its own exit code, and `add_gateway="$((1 - gateway_installed))"` printed by the `awk` inserter.
  3. Extend `scripts/verify-compose-boundaries.mjs` (lines 110-131) with a `gateway` location block, the same four streaming directives, the correct `proxy_pass`, and an upgrade-script assertion mirroring the API-key one — so the boundary gate fails if the route is missing, not merely if it is malformed.
  4. Extend `test/upgrade-nginx-routes.test.ts` fixtures and assertions so the gateway route is installed alongside the dashboard and API-key routes and the upgrade stays idempotent.
- **Success criteria:** the standalone nginx conf, the upgrade script, and the boundary assertions all carry the gateway route; the upgrade is idempotent; the boundary script fails when the route is removed.
- **Verify (POSIX host, Linux CI-owned):** `node scripts/verify-compose-boundaries.mjs` prints `compose-boundaries=pass`; `npx vitest run test/upgrade-nginx-routes.test.ts` exits 0. On a non-POSIX host, record both as CI-owned and run `node scripts/verify-compose-boundaries.mjs` to prove the assertion itself.

## Verification

```bash
npm run build -w @cloud-harness/contracts
npm run typecheck -w @cloud-harness/api
npx vitest run apps/api/test/mcp-gateway-service.test.ts apps/api/test/mcp-gateway-endpoint.test.ts apps/api/test/mcp-principal-context.test.ts
node scripts/verify-compose-boundaries.mjs
```

Success: every command exits 0; the endpoint suite asserts the five-tool surface, the
credential boundary (exact header on `tools/call`, absent from discovery, absent from
traces), the rebinding refusal, the permission denial path, and that `/mcp` is unchanged;
the compose-boundary script confirms the nginx route exists.

## Failure Protocol

If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

**What you may resolve without escalating** (record it in the PR description): fixture
shapes and internal helper splits. **What you must escalate**: any change to a frozen
interface, any verification failure, any weakening of the credential-scoping or
socket-pinning controls, and any change to a public contract (`/mcp` counts, result
envelope, or error codes).
