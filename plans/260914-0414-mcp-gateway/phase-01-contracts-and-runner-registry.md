# Phase 1: Contracts and Runner Registry

## Context Links
- Plan: `plans/260914-0414-mcp-gateway/plan.md`
- Contracts: `packages/contracts/src/mcp-gateway-schemas.ts` (new), `packages/contracts/src/internal-runner-api.ts`, `packages/contracts/src/index.ts`
- Runner: `apps/runner/src/metadata-schema.ts`, `apps/runner/src/mcp-gateway-store.ts` (new), `apps/runner/src/metadata-store.ts`, `apps/runner/src/dashboard-control-service.ts`, `apps/runner/src/secret-metadata-store.ts`
- Tests: `packages/contracts/test/mcp-gateway-contracts.test.ts` (new), `apps/runner/test/mcp-gateway-store.test.ts` (new), `apps/runner/test/mcp-gateway-control.test.ts` (new), `apps/runner/test/metadata-store.test.ts`, `apps/runner/test/api-key-store.test.ts`

## Requirements
- A principal-scoped MCP server registry persisted in the **metadata** SQLite ledger (schema v5 → v6), following the existing soft-delete + `generation` + `appendAudit` conventions.
- Supported transports are exactly `streamable-http` and `sse`. A `stdio` value must fail contract validation with a message naming the unsupported transport.
- Credentials are stored only as referenced secret names (`{ secretRef: NAME }`), never as resolved values.
- Cached downstream tool metadata, per-server + per-tool permission decisions (`allow` | `deny`), and execution traces are persisted and principal-scoped.
- A runner-internal operation resolves a server's referenced global secrets **only** for an explicit purpose that names the grant it is exercising, and never for a disabled server.
- Every response and trace contains no resolved credential value.
- No other principal's server can be read, changed, listed, or have its tools/traces returned.

## Interfaces to freeze (do not deviate)

```text
McpGatewayServerIdSchema  = /^mcps_[A-Za-z0-9_-]{20,80}$/
McpGatewayToolIdSchema    = /^mcpt_[A-Za-z0-9_-]{20,80}$/
McpGatewayTraceIdSchema   = /^mcpg_[A-Za-z0-9_-]{20,80}$/
McpGatewayTransportSchema = z.enum(['streamable-http', 'sse'])
McpGatewayPermissionSchema = z.enum(['allow', 'deny'])
McpGatewayServerStatusSchema = z.enum(['unknown', 'connected', 'connecting', 'disconnected', 'error', 'disabled'])
McpGatewayHeaderValueSchema = z.union([z.string(), z.object({ secretRef: SecretNameSchema }).strict()])
McpGatewayCredentialPurposeSchema = z.enum(['execute', 'connect'])
```

Qualified tool identity is `"<server-name>.<upstream-tool-name>"` where `server-name` matches
`/^[a-z0-9][a-z0-9-]{0,62}$/` and `upstream-tool-name` matches `/^[A-Za-z0-9_.-]{1,120}$/`.

**One frozen permissions payload name.** `McpGatewaySetPermissionsInputSchema` is exported from
the contracts module and is the *only* shape used at every hop (runner input, BFF body, UI form):

```text
McpGatewaySetPermissionsInputSchema = z.object({
  serverId: McpGatewayServerIdSchema,
  permissionDefault: McpGatewayPermissionSchema,
  tools: z.array(z.object({ name: z.string(), permission: McpGatewayPermissionSchema }).strict()).max(500),
  expectedGeneration: z.number().int().positive()
}).strict()
```

The server **view** field is `permissionDefault`; the tool **view** field is `permission` and its
meaning is frozen as the **effective** decision (override if present, else server default) — not
the raw override.

## Tasks & Steps

### Task 1.1 — Domain contracts
- **Goal:** a new exported contracts module defines the gateway enums, header reference union, server/tool/trace view schemas, the credential purpose enum, the frozen permissions input, and the qualified-tool-name validator.
- **Target files and symbols:** create `packages/contracts/src/mcp-gateway-schemas.ts`; add `export * from './mcp-gateway-schemas.js';` to `packages/contracts/src/index.ts`.
- **Steps:**
  1. Create the file with the schemas named in "Interfaces to freeze" plus:
     `McpGatewayHeaderNameSchema` (lowercase HTTP token regex, max 64, rejects `host`, `content-length`, `connection`, `transfer-encoding`), `McpGatewayServerNameSchema`, `McpGatewayToolNameSchema`, `McpGatewayQualifiedToolNameSchema` with `superRefine` splitting on the first `.`, `McpGatewayRemoteUrlSchema` (`z.string().url().max(2048)`), `McpGatewayToolAnnotationsSchema`, `McpGatewayServerViewSchema`, `McpGatewayToolViewSchema`, `McpGatewayTraceViewSchema`, `McpGatewaySetPermissionsInputSchema`, the create/update input schemas, and the exported helper `qualifiedToolName(serverName, toolName): string`.
  2. Every view schema is `.strict()`. `McpGatewayServerViewSchema` includes `id`, `principalId`, `name`, `description`, `transport`, `endpoint`, `headers` (array of `{ name, kind: 'literal' | 'secret', secretRef?: string }`), `enabled`, `status`, `toolCount`, `lastConnectedAt`, `lastError`, `lastCheckedAt`, `permissionDefault`, `generation`, `createdAt`, `updatedAt`. It must **not** contain any `value` field.
  3. `McpGatewayToolViewSchema` includes `id`, `principalId`, `serverId`, `qualifiedName`, `upstreamName`, `description`, `inputSchema` (`z.unknown()` — never transformed), `annotations`, `availability` (`'available' | 'unavailable'`), `permission` (effective), `discoveredAt`.
  4. `McpGatewayTraceViewSchema` includes `id`, `principalId`, `serverId`, `serverName`, `tool`, `operation`, `clientId`, `durationMs`, `status` (`'success' | 'error' | 'denied'`), `errorCode`, `errorMessage`, `requestBytes`, `responseBytes`, `createdAt`.
  5. `McpGatewayCreateInputSchema` and `McpGatewayUpdateInputSchema` reject `transport: 'stdio'` with the explicit message `'stdio downstream transport is not supported; use streamable-http or sse'`.
- **Success criteria:** `npm run build -w @cloud-harness/contracts` exits 0 and `McpGatewayTransportSchema.safeParse('stdio').success === false`.
- **Verify:** `npm run build -w @cloud-harness/contracts` exits 0.

### Task 1.2 — Contracts tests (write these first; they must fail before Task 1.1 lands)
- **Goal:** the contracts module's reject/accept behaviour is pinned.
- **Target files and symbols:** create `packages/contracts/test/mcp-gateway-contracts.test.ts`.
- **Steps:**
  1. Assert `McpGatewayTransportSchema` accepts exactly `['streamable-http', 'sse']` and rejects `'stdio'`, `'http'`, `''`.
  2. Assert `McpGatewayHeaderValueSchema` accepts `'Bearer x'` and `{ secretRef: 'POSTHOG_TOKEN' }` and rejects `{ value: 'plaintext' }`, `{ secretRef: 'lowercase' }`, and `{ secretRef: 'X', extra: 1 }`.
  3. Assert `qualifiedToolName('github', 'issue_create') === 'github.issue_create'` and that `McpGatewayQualifiedToolNameSchema` rejects `'nodot'`, `'.leading'`, `'trailing.'`, and a 200-character name.
  4. Assert `McpGatewayServerViewSchema` rejects an object carrying a `value` key inside a header entry.
  5. Assert every id schema rejects a wrong-prefix or short id.
  6. Assert `McpGatewaySetPermissionsInputSchema` accepts `{ serverId, permissionDefault, tools, expectedGeneration }` and rejects the same object with `default` in place of `permissionDefault`, proving there is exactly one field name.
- **Success criteria:** the new test file exits 0.
- **Verify:** `npx vitest run packages/contracts/test/mcp-gateway-contracts.test.ts` exits 0.

### Task 1.3 — Metadata schema v6
- **Goal:** the metadata ledger migrates v5 → v6 and back down, for a fresh database **and** for a database already at v5.
- **Note:** the existing migration is a fall-through chain, not a switch. Keeping the fast path at the *current* version (`=== 6`) and adding a `postV5` block after `postV4` is correct: a v5 database skips the fast path, fails every earlier guard, and lands on `postV5`. This was verified by executing the exact edit against a real v5 `node:sqlite` database (v5 → 6 in place, fresh → 6, re-run → 6). Do not restructure the chain.
- **Target files and symbols:** `apps/runner/src/metadata-schema.ts` (`migrateMetadataSchema`, new `downgradeMetadataSchemaToV5`, existing `downgradeMetadataSchemaToV4/V3/V2/V1`).
- **Steps:**
  1. Change the fast-path guard at line 14 from `row.version === 5` to `=== 6`.
  2. After the `postV4` block (line 158), add a `postV5` block guarded by `if (postV5 === 5)` that creates these tables and sets version 6:
     - `mcp_gateway_servers` (`id`, `principal_id` FK to `principals(id)` ON DELETE RESTRICT, `name`, `description`, `transport` CHECK IN `('streamable-http','sse')`, `endpoint`, `headers_json`, `enabled` CHECK IN `(0,1)`, `status` CHECK IN `('unknown','connected','connecting','disconnected','error','disabled')`, `tool_count`, `last_connected_at`, `last_error`, `last_checked_at`, `permission_default` CHECK IN `('allow','deny')`, `state` CHECK IN `('ACTIVE','DELETED')`, `generation`, `created_at`, `updated_at`, `deleted_at`, `UNIQUE(principal_id, id)`, `UNIQUE(principal_id, name)`).
     - `mcp_gateway_tools` (`id`, `principal_id`, `server_id`, `upstream_name`, `qualified_name`, `description`, `input_schema_json`, `schema_bytes`, `annotations_json`, `availability` CHECK IN `('available','unavailable')`, `discovered_at`, `PRIMARY KEY(principal_id, server_id, upstream_name)`, `UNIQUE(principal_id, qualified_name)`, `FOREIGN KEY(principal_id, server_id) REFERENCES mcp_gateway_servers(principal_id, id) ON DELETE CASCADE`).
     - `mcp_gateway_tool_permissions` (`principal_id`, `server_id`, `tool_name`, `permission` CHECK IN `('allow','deny')`, `PRIMARY KEY(principal_id, server_id, tool_name)`, same composite FK).
     - `mcp_gateway_traces` (`id`, `principal_id` FK to `principals(id)`, `server_id`, `server_name`, `tool`, `operation`, `client_id`, `duration_ms`, `status` CHECK IN `('success','error','denied')`, `error_code`, `error_message`, `request_bytes`, `response_bytes`, `created_at`). `server_id` is deliberately FK-free so a trace outlives a soft-deleted server row without blocking the delete; `deleteServer` removes the server's traces explicitly (Task 1.4).
     - Indexes: `mcp_servers_principal_updated(principal_id, updated_at DESC, id)`, `mcp_tools_principal_server(principal_id, server_id)`, `mcp_traces_principal_created(principal_id, created_at DESC, id)`, `mcp_traces_principal_server(principal_id, server_id, created_at DESC)`.
  3. Change the terminal assertion at lines 159–160 to `if (migrated !== 6) throw new Error(\`unsupported metadata schema version ${migrated}\`);`.
  4. **Guard the FK prerequisite.** Before creating the v6 tables, verify the FK target exists, because `principals` is created by `StateStore`'s migration and `MetadataStore` does not create it:
     `if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='principals'").get()) throw new Error('metadata migration requires the principals table; construct StateStore on this database first');`
  5. Add `downgradeMetadataSchemaToV5(database)` that requires version 6, drops the four tables (children first), and sets version 5. It opens its own `BEGIN IMMEDIATE` like every sibling.
  6. **Chain the ladder outside any transaction, re-reading after each step.** `downgradeMetadataSchemaToV3/V2/V1` currently pre-chain only from v5 with a stale snapshot; a v6 database would otherwise drop to v5 and then fail its own guard. At the top of each of `downgradeMetadataSchemaToV4`, `downgradeMetadataSchemaToV3`, `downgradeMetadataSchemaToV2`, and `downgradeMetadataSchemaToV1`, **before** that function's own `BEGIN IMMEDIATE`, add re-reading steps:
     ```ts
     const step = () => (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined)?.version;
     if (step() === 6) downgradeMetadataSchemaToV5(database);
     if (step() === 5 && <this function's target is below 5>) downgradeMetadataSchemaToV4(database);
     ```
     For `downgradeMetadataSchemaToV4` only the first line is needed. Never call a sibling from inside another function's `BEGIN IMMEDIATE` — that throws `cannot start a transaction within a transaction`.
  7. Widen each guard's accepted-version check and error message to include 6 where the ladder can now arrive from 6 (specifically the `downgradeMetadataSchemaToV1` message becomes `'metadata schema must be version 2, 3, 4, 5, or 6 before downgrade'`).
  8. **Update every affected assertion, not just the ones near line 38.** In `apps/runner/test/metadata-store.test.ts` update the version assertions at lines 38, 366, and 382; in `apps/runner/test/api-key-store.test.ts` update line 171 (a version number) and line 180 (a guard **message string**, which must match the widened message from step 7).
- **Success criteria:** a fresh database reports version 6; an existing v5 database upgrades in place to version 6 with the gateway tables present; each of `downgradeMetadataSchemaToV5/V4/V3/V2/V1` can be entered directly from version 6 without throwing and without leaving `mcp_gateway_*` tables behind.
- **Verify:** `npx vitest run apps/runner/test/metadata-store.test.ts apps/runner/test/api-key-store.test.ts` exits 0.

### Task 1.4 — `McpGatewayStore`
- **Goal:** a single store class owns every gateway read/write against the v6 tables.
- **Target files and symbols:** create `apps/runner/src/mcp-gateway-store.ts`; edit `apps/runner/src/metadata-store.ts` (private field + `get mcpGateway()` accessor).
- **Steps:**
  1. `export class McpGatewayStore { constructor(readonly database: DatabaseSync) {} }`.
  2. Implement, all taking `principalId: string` first, all serializing `headers_json`/`input_schema_json`/`annotations_json` with `JSON.stringify`, all mapping rows to the contract views:
     - `listServers(principalId)` — `WHERE principal_id = ? AND state = 'ACTIVE' ORDER BY updated_at DESC, id`.
     - `getServer(principalId, serverId)`.
     - `createServer(principalId, input, expectedGeneration: 0)` — inside `transaction`; `opaqueId('mcps')`; duplicate name returns `undefined`; `appendAudit(database, principalId, 'mcp_server.created', 'mcp_server', id, 1, { transport }, now)`.
     - `updateServer(principalId, serverId, expectedGeneration, patch)` — generation-fenced `UPDATE`, bump `generation`, audit `mcp_server.updated`. **When the patch changes `name`, rewrite `qualified_name` for that server's tool rows in the same transaction** (`UPDATE mcp_gateway_tools SET qualified_name = ? || '.' || upstream_name WHERE principal_id = ? AND server_id = ?`), so the cached catalog never advertises a stale prefix.
     - `setEnabled(principalId, serverId, enabled, expectedGeneration)` — status becomes `'disabled'` when disabled; audit `mcp_server.enabled` / `mcp_server.disabled`.
     - `setPermissions(principalId, serverId, input: McpGatewaySetPermissionsInput)` — replaces the tool-override rows in one transaction and bumps server `generation`; audit `mcp_policy.updated` with `{ default: input.permissionDefault, overrides: input.tools.length }`.
     - `deleteServer(principalId, serverId, expectedGeneration)` — soft delete (`state='DELETED'`), **hard-deletes its tool rows, permission rows, and trace rows**, and audits `mcp_server.deleted`. Deleting a server therefore deletes its logs; this is deliberate and documented, and it prevents both orphaned traces and a reused id resurfacing another server's history.
     - `replaceTools(principalId, serverId, tools, cap)` — delete-then-insert tool rows in one transaction applying `cap`; update `tool_count`, `status`, `last_checked_at`, and `last_connected_at` when `status === 'connected'`; clear `last_error` on success. Tools beyond `cap` are stored as `availability: 'unavailable'` with `description: 'tool omitted: per-server tool limit reached'` rather than silently dropped, so `status` stays honest.
     - `recordConnectionResult(principalId, serverId, status, error)` — updates `status`, `last_error` (sanitized, max 500 chars), `last_checked_at`, and `last_connected_at` on success; must not bump `generation`.
     - `listTools(principalId, serverId?)`; `getTool(principalId, qualifiedName)` (exposed and used — see Task 1.7); `getServerTools(principalId, serverId)`.
     - `catalog(principalId, filter?: { serverId?: string; qualifiedName?: string })` — one query per table, joined in memory, **filtered in SQL** when a filter is supplied so `inspect`/`execute` never transfer the whole fleet.
     - `effectivePermission(principalId, serverId, toolName)` — tool override wins, else server `permission_default`. This is the single source of truth; the API must not re-derive it.
     - `appendTrace(principalId, trace, maxRows)` — `opaqueId('mcpg')`, truncates `error_message` to 500 chars, then prunes that principal's oldest rows beyond `maxRows`.
     - `listTraces(principalId, { serverId?, limit, cursor? })` — keyset pagination on `(created_at, id)`.
  3. In `apps/runner/src/metadata-store.ts`: add `private readonly availableMcpGateway: McpGatewayStore;` constructed right after `migrateMetadataSchema(this.database)`, plus `get mcpGateway(): McpGatewayStore`.
  4. A server that belongs to another principal must resolve to `undefined`/no rows exactly like `MetadataStore.project`.
- **Success criteria:** the store compiles and every method is principal-scoped.
- **Verify:** `npm run typecheck -w @cloud-harness/runner` exits 0.

### Task 1.5 — Store tests
- **Goal:** registry CRUD, enable/disable, user isolation, rename, tool replacement, permission resolution, trace retention, and audit are covered.
- **Target files and symbols:** create `apps/runner/test/mcp-gateway-store.test.ts`.
- **Steps:**
  1. Reuse the `setup()` pattern from `apps/runner/test/dashboard-control-service.test.ts` (StateStore → resolvePrincipal for two external principals `operator-a`/`operator-b` → close → MetadataStore with a `SecretKeyring`).
  2. Test: create returns generation 1 with `status: 'unknown'`; duplicate name returns `undefined`; update with a stale generation returns `undefined`.
  3. Test: **rename** rewrites the cached `qualified_name` for every tool of that server (assert `getTool(principalId, 'gh.issue_create')` resolves after renaming `github` → `gh`, and the old qualified name no longer resolves).
  4. Test: `setEnabled(false)` yields `status: 'disabled'` and `enabled === false`; `deleteServer` removes tools, permissions, **and traces**, and leaves no `mcp_gateway_traces` rows for that server.
  5. Test: `replaceTools` with a cap of 2 stores two available + one `unavailable` row for three upstream tools, and a second call leaves exactly three rows (no orphans).
  6. Test: `effectivePermission` returns the server default, then the tool override wins for the overridden tool only.
  7. Test: every `list*`/`get*`/`catalog`/`effectivePermission` call by `operator-b` returns empty/`undefined` for `operator-a`'s server.
  8. Test: `appendTrace` + `listTraces` round-trip with `serverId` filtering, and that `appendTrace` with `maxRows = 3` leaves exactly 3 rows after 5 appends.
  9. Test: `listAudit` contains `mcp_server.created`, `mcp_server.updated`, `mcp_server.deleted`, `mcp_policy.updated`.
  10. Test: a header entry `{ secretRef: 'GH_TOKEN' }` round-trips as metadata only and the serialized row contains no `value` key.
- **Success criteria:** the suite passes and no assertion is tautological.
- **Verify:** `npx vitest run apps/runner/test/mcp-gateway-store.test.ts` exits 0.

### Task 1.6 — Global secret plaintext resolver
- **Goal:** the runner can resolve one principal's named **runtime** global secret to plaintext for gateway credential injection, without exposing it anywhere else.
- **Correction (load-bearing):** global secrets are encrypted with `environmentId: 'global'` as AES-GCM associated data, and the ciphertext lives in `global_secret_versions`, not in the `global_secret_references` row that `globalByName` returns. A resolver built on `globalByName` plus `environmentId: ''` cannot decrypt anything.
- **Target files and symbols:** `apps/runner/src/secret-metadata-store.ts` (new public method `globalValue`), `apps/runner/src/metadata-store.ts` (thin wrapper).
- **Steps:**
  1. Add to `SecretMetadataStore`:
     ```ts
     globalValue(principalId: string, name: string): string | undefined
     ```
     Query exactly like the global branch of `consumeProvisioningSecret` (line 338), but require `refs.state = 'ACTIVE'` and **do not** filter on `purpose`:
     ```sql
     SELECT versions.*, refs.name, refs.id AS secret_reference_id
     FROM global_secret_references refs
     JOIN global_secret_versions versions
       ON versions.principal_id = refs.principal_id
      AND versions.secret_reference_id = refs.id
      AND versions.version = refs.current_version
     WHERE refs.principal_id = ? AND refs.name = ? AND refs.state = 'ACTIVE'
     ```
     Return `undefined` when no row. Decrypt with the **global** context:
     ```ts
     this.keyring.decrypt(envelope(row), { principalId, environmentId: 'global', name: row.name, version: row.version })
     ```
  2. Add `MetadataStore.globalSecretValue(principalId, name): string | undefined` delegating to `this.secrets.globalValue`.
  3. Add **defence-in-depth scrubbing in the runner**: export a small `scrubCredentialText(text)` in the new store module that strips header-ish lines and known secret values, and call it on `error_message` inside `appendTrace` so an API-side redaction bug cannot persist a credential.
  4. Do not add any operation that returns this value directly; it is consumed only by credential resolution (Task 1.7).
- **Success criteria:** a runtime global secret created through `global_secret_create` resolves by name to its exact plaintext for its owner, returns `undefined` for another principal, and still resolves after a `global_secret_rotate`.
- **Verify:** `npx vitest run apps/runner/test/mcp-gateway-control.test.ts` exits 0 after Task 1.7 adds the assertions.

### Task 1.7 — Internal operations and control-service cases
- **Goal:** the dashboard BFF can drive the registry, and the gateway can obtain resolved credentials through an explicitly scoped, audited operation.
- **Target files and symbols:** `packages/contracts/src/internal-runner-api.ts`, `apps/runner/src/dashboard-control-service.ts`.
- **Steps:**
  1. In `MetadataRunnerOperationSchema` (line 75) append:
     `'mcp_server_list', 'mcp_server_get', 'mcp_server_create', 'mcp_server_update', 'mcp_server_delete', 'mcp_server_set_enabled', 'mcp_server_set_permissions', 'mcp_server_replace_tools', 'mcp_server_connection_result', 'mcp_server_get_credentials', 'mcp_gateway_catalog', 'mcp_gateway_trace_append', 'mcp_gateway_trace_list'`.
     **Every one of these 13 operations must also be added to `DashboardResponseOperation` in `apps/api/src/dashboard-response.ts` (Phase 4, Task 4.1).** `endpoint()` forwards a `MetadataRunnerOperation` into `sendRunnerResponse`, whose parameter is `DashboardResponseOperation`; omitting any member breaks `npm run typecheck -w @cloud-harness/api`. This is not optional or partial.
  2. Add matching entries to `metadataInputs` (line 92) using the frozen schemas, with `expectedGeneration: z.literal(0)` for create and `generation` for update/delete/enable/permissions. `mcp_server_set_permissions` uses `McpGatewaySetPermissionsInputSchema.omit({ serverId: true, expectedGeneration: true }).extend({ serverId: internalId('mcps'), expectedGeneration: generation })` so the field name is identical at every hop.
  3. `mcp_server_get_credentials` takes:
     ```ts
     { serverId: internalId('mcps'), toolName: z.string().max(120).optional(), purpose: McpGatewayCredentialPurposeSchema }
     ```
  4. In `DashboardControlService.execute` add one `case` per operation. Reads return `ok(...)`; mutations return `mutation(...)`.
     - `mcp_server_get_credentials` rules, in order:
       1. Resolve the server; missing/foreign → `HarnessError('NOT_FOUND', 'MCP server is unavailable', 404, false)`.
       2. **Disabled server → `ok('MCP server is disabled', { allowed: false, reason: 'server_disabled' })`** regardless of purpose.
       3. `purpose === 'execute'`: require `toolName`; the tool must exist in the cache for that server **and** `effectivePermission(...) === 'allow'`, else `ok('MCP tool access denied', { allowed: false, reason: 'tool_denied' })`.
       4. `purpose === 'connect'`: permitted regardless of tool-level denial, because connectivity testing is a server-level operator action and a deny-by-default server must remain testable. This is an explicit, audited grant — not a bypass of the `execute` gate.
       5. Resolve each header entry (`kind: 'secret'` → `this.metadata.globalSecretValue(principalId, ref)`; a missing secret is `HarnessError('NOT_FOUND', 'referenced secret <NAME> is unavailable', 404, false)` — the message names the reference, never a value).
       6. Append an audit event `mcp_gateway.credentials_resolved` with `{ serverId, purpose, toolName: toolName ?? null, headerCount }` — never a value.
       7. Return `ok('MCP credentials resolved', { allowed: true, transport, endpoint, headers })`.
     - `mcp_server_get` returns `{ server, tools }`.
     - `mcp_gateway_catalog` accepts an optional `{ serverId?, qualifiedName? }` filter and returns `{ servers, tools }` filtered to `state = 'ACTIVE'`.
     - `mcp_gateway_trace_append` passes `maxRows` from the runner config.
  5. Add a `private mcp() { return this.metadata.mcpGateway; }` accessor mirroring `secrets()` (line 395).
- **Success criteria:** the new operations round-trip through `DashboardControlService.execute`; a denied tool returns `allowed: false` with no header value; a disabled server returns `allowed: false`; `purpose: 'connect'` resolves for a deny-by-default server.
- **Verify:** `npx vitest run apps/runner/test/mcp-gateway-control.test.ts` exits 0.

### Task 1.8 — Control-service tests
- **Goal:** operation-level behaviour, isolation, the disabled/deny matrix, secret rotation, and the credential-leakage guarantee are covered.
- **Target files and symbols:** create `apps/runner/test/mcp-gateway-control.test.ts`.
- **Steps:**
  1. Copy the `setup()` + `request()` helper structure from `apps/runner/test/dashboard-control-service.test.ts`.
  2. Test create/list/get/update/delete/set_enabled/set_permissions through `controls.execute`, including the frozen `permissionDefault` field name (a `default` key must be rejected).
  3. Test that a second principal's `mcp_server_get`, `mcp_server_update`, `mcp_server_delete`, and `mcp_gateway_catalog` never include the first principal's server, and that a stale generation yields `HarnessError('CONFLICT')`.
  4. Test `get_credentials` matrix:
     - `purpose: 'execute'` + denied tool override → `{ allowed: false, reason: 'tool_denied' }` and `JSON.stringify(result)` contains no secret value, and the downstream is never contacted (asserted in Phase 3).
     - `purpose: 'execute'` + allowed tool → header resolves to the **exact** plaintext.
     - `purpose: 'execute'` + unknown toolName → `allowed: false`.
     - **disabled server + `purpose: 'connect'` → `{ allowed: false, reason: 'server_disabled' }`.**
     - deny-by-default server + `purpose: 'connect'` → `allowed: true` (connectivity grant).
     - `purpose: 'execute'` on a deny-by-default server with no tools → `allowed: false`.
  5. Test that a missing referenced secret produces `NOT_FOUND` whose message names the secret **reference** and still leaks no value.
  6. Test rotation: rotate the global secret, then `get_credentials` again returns the **new** exact plaintext.
  7. Test `mcp_server_replace_tools` sets `toolCount` and the cap behaviour, and `mcp_gateway_trace_append`/`trace_list` round-trips.
  8. Test that a trace recorded from an upstream error containing the secret in raw, base64, and percent-encoded form has none of those forms in `listTraces` output (exercise `scrubCredentialText`).
  9. Test that `audit_list` contains `mcp_gateway.credentials_resolved`.
- **Success criteria:** the suite passes; the secret string and its encoded forms appear in no serialized response.
- **Verify:** `npx vitest run apps/runner/test/mcp-gateway-control.test.ts` exits 0.

## Verification

```bash
npm run build -w @cloud-harness/contracts
npm run typecheck -w @cloud-harness/runner
npx vitest run packages/contracts/test/mcp-gateway-contracts.test.ts apps/runner/test/mcp-gateway-store.test.ts apps/runner/test/mcp-gateway-control.test.ts apps/runner/test/metadata-store.test.ts apps/runner/test/api-key-store.test.ts
```

Success: every command exits 0; the v5 → v6 in-place upgrade path is exercised; the
credential matrix covers allowed, tool-denied, unknown-tool, disabled, and connect-grant;
and the serialized responses in the secret tests contain no secret value.

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

**What you may resolve without escalating** (record the decision in the PR description):
a naming choice the frozen interfaces already fix, a test fixture shape, or an
internal helper split. **What you must escalate** (Failure Protocol): any change to a
frozen interface, any verification failure, any security control that has to be
weakened, and any contradiction between two phase files.
