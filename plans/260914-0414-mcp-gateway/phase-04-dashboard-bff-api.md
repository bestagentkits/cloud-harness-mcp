# Phase 4: Dashboard BFF API for MCP Servers

## Context Links
- Plan: `plans/260914-0414-mcp-gateway/plan.md`
- API: `apps/api/src/dashboard-control-router.ts`, `apps/api/src/dashboard-response.ts`, `apps/api/src/dashboard-router.ts`, `apps/api/src/dashboard-gateway-router.ts` (new)
- Tests: `apps/api/test/dashboard-mcp-gateway-api.test.ts` (new)

## Requirements
- The dashboard BFF exposes principal-scoped registry management, permissions, tools, logs, connection test, tool refresh, and the gateway endpoint.
- **Every one of the 13 new metadata operations is added to `DashboardResponseOperation`**, because `endpoint()` forwards a `MetadataRunnerOperation` into `sendRunnerResponse`, whose parameter type is `DashboardResponseOperation`. A partial addition is a compile error; a cast would let an unmapped operation fall through `mapDashboardData`'s `return data` with no allowlist.
- Every response is mapped through an explicit key allowlist that contains no secret value and no resolved header value.
- Gateway failures surface an actionable message, not the workspace-oriented generic text.
- Connection test, tool refresh, and any registry mutation invalidate the API-side cache and connection.
- A route for another principal's server resolves as not-found, never as another principal's data.

## Interfaces to freeze (do not deviate)

```text
GET    /dashboard/api/v1/mcp-servers                       → mcp_server_list
POST   /dashboard/api/v1/mcp-servers                       → mcp_server_create
GET    /dashboard/api/v1/mcp-servers/:serverId             → mcp_server_get
PATCH  /dashboard/api/v1/mcp-servers/:serverId             → mcp_server_update
DELETE /dashboard/api/v1/mcp-servers/:serverId             → mcp_server_delete
POST   /dashboard/api/v1/mcp-servers/:serverId/enabled     → mcp_server_set_enabled
PUT    /dashboard/api/v1/mcp-servers/:serverId/permissions → mcp_server_set_permissions
POST   /dashboard/api/v1/mcp-servers/:serverId/refresh     → gateway.refreshServer (custom handler)
POST   /dashboard/api/v1/mcp-servers/:serverId/test        → gateway.testServer (custom handler)
GET    /dashboard/api/v1/mcp-servers/:serverId/logs        → mcp_gateway_trace_list
GET    /dashboard/api/v1/mcp-gateway                       → gateway endpoint projection (custom handler)
```

## Tasks & Steps

### Task 4.1 — Response mapping, allowlists, and gateway messages
- **Goal:** every new operation is mapped and type-checked, with a no-secret allowlist and actionable errors.
- **Target files and symbols:** `apps/api/src/dashboard-response.ts` (`DashboardResponseOperation`, key allowlists, `mapDashboardData`, `descriptiveOperations`, `messages`).
- **Steps:**
  1. Add **all 13** operations to the `DashboardResponseOperation` union (line 34): `'mcp_server_list'`, `'mcp_server_get'`, `'mcp_server_create'`, `'mcp_server_update'`, `'mcp_server_delete'`, `'mcp_server_set_enabled'`, `'mcp_server_set_permissions'`, `'mcp_server_replace_tools'`, `'mcp_server_connection_result'`, `'mcp_server_get_credentials'`, `'mcp_gateway_catalog'`, `'mcp_gateway_trace_append'`, `'mcp_gateway_trace_list'`. After the change, `MetadataRunnerOperationSchema.options` must remain a subset of this union — `npm run typecheck -w @cloud-harness/api` proves it.
  2. Add allowlist constants next to `knowledgeItemKeys`:
     - `mcpServerKeys = ['id','name','description','transport','endpoint','headers','enabled','status','toolCount','lastConnectedAt','lastError','lastCheckedAt','permissionDefault','generation','createdAt','updatedAt']`
     - `mcpToolKeys = ['id','serverId','qualifiedName','upstreamName','description','inputSchema','annotations','availability','permission','discoveredAt']`
     - `mcpTraceKeys = ['id','serverId','serverName','tool','operation','clientId','durationMs','status','errorCode','errorMessage','requestBytes','responseBytes','createdAt']`
     - `mcpHeaderKeys = ['name','kind','secretRef']` (never `value`).
  3. Add `mapDashboardData` branches:
     - `mcp_server_list` → `{ servers: list(value.servers, mcpServerKeys) }` with each server's `headers` re-mapped through `pick(header, mcpHeaderKeys)`.
     - `mcp_server_get` → `{ server: <mapped>, tools: list(value.tools, mcpToolKeys) }`.
     - mutations → `pick(value, mcpServerKeys)` with headers re-mapped.
     - `mcp_gateway_trace_list` → `{ traces: list(value.traces, mcpTraceKeys) }`.
     - `mcp_server_get_credentials`, `mcp_gateway_catalog`, `mcp_server_replace_tools`, `mcp_server_connection_result` → mapped to the minimal safe projection (`allowed`/`reason` only for credentials; never headers).
  4. Add the mutation operations to `descriptiveOperations` (line 147) **and** add the gateway read operations (`mcp_server_get`, `mcp_server_list`, `mcp_gateway_trace_list`) so the runner's real message survives.
  5. Add gateway-specific messages so a missing secret or a missing server does not surface workspace text. Prefer a per-operation message override over editing the shared `messages` table:
     ```ts
     const operationMessages: Partial<Record<DashboardResponseOperation, Partial<Record<string, string>>>> = {
       mcp_server_get: { NOT_FOUND: 'MCP server not found.' },
       mcp_server_list: { UNAVAILABLE: 'The MCP registry is temporarily unavailable.' },
       mcp_server_set_permissions: { CONFLICT: 'This MCP server changed after you opened it.' },
       mcp_gateway_trace_list: { NOT_FOUND: 'MCP server not found.' }
     };
     ```
     and consult it before `messages[code]` in `sendRunnerResponse`.
  6. Assert in the phase test that `JSON.stringify(responseBody)` contains neither a secret value nor a `"value"` key inside `headers`.
- **Success criteria:** typecheck passes and no mapped payload can carry a resolved header.
- **Verify:** `npm run typecheck -w @cloud-harness/api` exits 0.

### Task 4.2 — Registry routes
- **Goal:** CRUD, enable/disable, permissions, and logs are reachable through `endpoint()`.
- **Target files and symbols:** `apps/api/src/dashboard-control-router.ts`.
- **Steps:**
  1. After the knowledge block (line 144), add routes using the existing `endpoint(operation, input)` helper and `internalId('mcps')` for `:serverId`:
     ```ts
     router.get('/api/v1/mcp-servers', endpoint('mcp_server_list', () => ({})));
     router.post('/api/v1/mcp-servers', endpoint('mcp_server_create', (request) => (request.body && typeof request.body === 'object' ? request.body : {})));
     router.get('/api/v1/mcp-servers/:serverId', endpoint('mcp_server_get', (request) => ({ serverId: internalId('mcps').parse(request.params.serverId) })));
     router.patch('/api/v1/mcp-servers/:serverId', endpoint('mcp_server_update', (request) => ({ serverId: internalId('mcps').parse(request.params.serverId), ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
     router.delete('/api/v1/mcp-servers/:serverId', endpoint('mcp_server_delete', (request) => ({ serverId: internalId('mcps').parse(request.params.serverId), ...generation.parse(request.body) })));
     router.post('/api/v1/mcp-servers/:serverId/enabled', endpoint('mcp_server_set_enabled', (request) => ({ serverId: internalId('mcps').parse(request.params.serverId), ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
     router.put('/api/v1/mcp-servers/:serverId/permissions', endpoint('mcp_server_set_permissions', (request) => ({ serverId: internalId('mcps').parse(request.params.serverId), ...(request.body && typeof request.body === 'object' ? request.body : {}) })));
     router.get('/api/v1/mcp-servers/:serverId/logs', endpoint('mcp_gateway_trace_list', (request) => ({ serverId: internalId('mcps').parse(request.params.serverId), limit: Number(request.query.limit ?? 50), ...(request.query.cursor ? { cursor: String(request.query.cursor) } : {}) })));
     ```
  2. `mcp_server_set_permissions` forwards exactly `{ permissionDefault, tools, expectedGeneration }` — the frozen field name from Phase 1. Do not forward `default`.
  3. The existing router `use` error handler already maps `ZodError` → 400 (line 239), so a malformed `:serverId` yields 400; assert that in the phase test rather than adding new handling.
- **Success criteria:** each route calls the matching internal operation with the right input shape.
- **Verify:** `npx vitest run apps/api/test/dashboard-mcp-gateway-api.test.ts` exits 0.

### Task 4.3 — Gateway-connected routes
- **Goal:** test/refresh and the endpoint projection run in the API where the connection manager lives, and mutations evict stale API-side state.
- **Target files and symbols:** create `apps/api/src/dashboard-gateway-router.ts`; edit `apps/api/src/dashboard-router.ts`.
- **Steps:**
  1. Export `registerDashboardGatewayRoutes(router, gateway, principal, config)` where `gateway` is the `McpGatewayService`.
  2. `POST /api/v1/mcp-servers/:serverId/test`: validate the id, resolve the principal with the shared `principal()` helper, call `gateway.testServer(principal, serverId, { clientId: 'dashboard' })`, and respond `{ data: { status, toolCount, error } }` with a sanitized error. A failed test answers HTTP 200 with `status: 'error'` — the test result is data, not a transport error.
  3. `POST /api/v1/mcp-servers/:serverId/refresh`: same shape via `gateway.refreshServer`, then `gateway.invalidateCatalog(principal)`.
  4. `GET /api/v1/mcp-gateway`: respond `{ data: { endpoint: '/mcp-gateway', publicUrl } }` where `publicUrl` is built from the request's **allowlisted** `Host` header as `https://<host>/mcp-gateway`, plus `authMode` so the UI can state which credential lane the endpoint accepts. Never echo a query string.
  5. **Evict on every mutation.** The `endpoint()` helper cannot do this, so wrap the mutating routes so that after a successful non-error response the handler calls `gateway.invalidateCatalog(principal)` and — for routes that carry a `serverId` — `gateway.service.invalidateConnection(serverId)` (expose `connections.invalidate` through the service). Apply this to `mcp_server_update`, `mcp_server_delete`, `mcp_server_set_enabled`, `mcp_server_set_permissions`, `mcp_server_create`, `refresh`, and `test`. Deleting a server must close its cached connection so a resolved credential does not stay resident.
  6. In `apps/api/src/dashboard-router.ts`, accept the gateway service, call `registerDashboardGatewayRoutes(router, gateway, principal, config)` after `registerDashboardControlRoutes`, and update the `apps/api/src/app.ts` call site to pass `runtime.gateway`.
- **Success criteria:** the three routes answer with mapped data under the same CSRF/auth as the rest of the dashboard, and a mutation evicts cached state.
- **Verify:** `npx vitest run apps/api/test/dashboard-mcp-gateway-api.test.ts` exits 0.

### Task 4.4 — BFF tests
- **Goal:** routes, isolation, eviction, error messaging, and the no-secret guarantee are covered.
- **Target files and symbols:** create `apps/api/test/dashboard-mcp-gateway-api.test.ts`.
- **Steps:**
  1. Mirror `apps/api/test/knowledge-api.test.ts`: real Express on port 0, `app.use('/dashboard', createDashboardRouter(config, runner, gateway))`, a middleware injecting `request.auth` with an external principal, and a fake `runner` whose `callInternal` is a `vi.fn` recording `{ operation, input, principal }`.
  2. Bootstrap the session (`GET /dashboard/api/v1/session`) and send the `x-csrf-token` header plus the session cookie on every mutation, exactly as `dashboard-models-router.test.ts:64-97` does.
  3. Assert each route maps to the expected operation and input, including `internalId('mcps')` rejecting a malformed id with **400** (via the existing `ZodError` handler).
  4. Assert the `PUT .../permissions` body uses `permissionDefault` and that a body carrying `default` fails with 400.
  5. Assert a `404`/`409` runner result maps to the matching HTTP status via `sendRunnerResponse`.
  6. Assert a missing-referenced-secret `NOT_FOUND` surfaces a gateway-specific message naming the reference, not `Workspace not found or no longer available.`
  7. Assert the create response never contains a `value` field and that a configured secret reference appears only as `{ name, kind: 'secret', secretRef }`.
  8. Assert `POST .../test` delegates to the gateway service and returns `{ status, toolCount }`.
  9. Assert `PUT .../permissions` invokes `gateway.invalidateCatalog` and `invalidateConnection`, and that `DELETE` invokes `invalidateConnection` for the deleted server.
  10. Assert `GET /api/v1/mcp-gateway` returns the endpoint and that `publicUrl` is derived from the allowlisted Host and includes no query string.
- **Success criteria:** the suite passes.
- **Verify:** `npx vitest run apps/api/test/dashboard-mcp-gateway-api.test.ts` exits 0.

## Verification

```bash
npm run build -w @cloud-harness/contracts
npm run typecheck -w @cloud-harness/api
npx vitest run apps/api/test/dashboard-mcp-gateway-api.test.ts apps/api/test/dashboard-router.test.ts apps/api/test/knowledge-api.test.ts
```

Success: every command exits 0; the new suite asserts route→operation mapping, status
mapping, gateway-specific error messaging, cache eviction on mutation, and the no-secret
payload guarantee; the existing dashboard suites still pass.

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

**What you may resolve without escalating** (record it in the PR description): internal
helper placement and test fixture shapes. **What you must escalate**: any change to a
frozen interface, any verification failure, any cast that would bypass the response
allowlist, and any change to an existing dashboard response contract.
