# Phase 2: Gateway Catalog, Connections, and Traces

## Context Links
- Plan: `plans/260914-0414-mcp-gateway/plan.md`
- API: `apps/api/src/mcp-gateway/url-policy.ts` (new), `apps/api/src/mcp-gateway/redaction.ts` (new), `apps/api/src/mcp-gateway/catalog.ts` (new), `apps/api/src/mcp-gateway/connection-manager.ts` (new), `apps/api/src/mcp-gateway/types.ts` (new)
- Config: `packages/contracts/src/config.ts`, `apps/api/src/config.ts`, `.env.example`
- Tests: `apps/api/test/mcp-gateway-url-policy.test.ts` (new), `apps/api/test/mcp-gateway-catalog.test.ts` (new), `apps/api/test/mcp-gateway-connection.test.ts` (new)

## Requirements
- The API validates every remote MCP endpoint against SSRF before it is persisted and again before every outbound connect, and **pins the socket to the address it validated** so a rebinding resolver cannot redirect the request.
- Cleartext HTTP is a non-production-only affordance and cannot carry a credential in a Cloudflare Access deployment.
- A bounded connection manager lazily connects per server, isolates per-server failure, times out, reconnects single-flight, bounds its cache, and shuts down cleanly without hanging waiters.
- The resolved credential is attached only to requests for the configured MCP endpoint, never to SDK discovery probes.
- Discovery lists a server's tools and normalizes them into cached tool views without mutating the upstream schema and within byte/tool caps.
- Search is deterministic lexical/fuzzy over cached metadata and never returns disabled servers or denied tools.
- Redaction keeps secret values and credential headers out of every log, error, and trace, including encoded forms.

## Interfaces to freeze (do not deviate)

```text
validateGatewayEndpoint(rawUrl, options): Promise<{ ok: true; url: URL; addresses: Array<{ address: string; family: 4 | 6 }> } | { ok: false; error: string }>
class GatewayConnectionManager {
  constructor(options: { timeoutMs; maxResponseBytes; maxConnections; allowInsecureHttp; allowPrivateEndpoints; fetchImpl?; now? })
  withConnection<T>(server, headers, fn: (client) => Promise<T>, signal?): Promise<T>
  invalidate(serverId: string): void
  health(serverId: string): 'connected' | 'disconnected' | 'unknown'
  size(): number
  closeAll(): Promise<void>
}
searchTools(tools, query, options: { server?: string; limit: number }): Array<{ tool; score }>
normalizeUpstreamTools(server, tools, options: { maxTools: number; maxSchemaBytes: number }): McpGatewayToolView[]
redactGatewayError(error: unknown, secrets: string[]): { code: ErrorCode; message: string }
```

## Tasks & Steps

### Task 2.1 — API config keys
- **Goal:** the gateway's bounds are configurable with safe defaults, and the dangerous ones are mode-gated.
- **Target files and symbols:** `packages/contracts/src/config.ts` (`ApiConfigSchema`, line 109), `apps/api/src/config.ts` (`loadApiConfig`, line 14), `.env.example`.
- **Steps:**
  1. Add to `ApiConfigSchema` after `maxBodyBytes` (line 127):
     - `mcpGatewayTimeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(30_000)`
     - `mcpGatewayMaxResponseBytes: z.coerce.number().int().min(1_024).max(1_048_576).default(262_144)`
     - `mcpGatewayMaxToolsPerServer: z.coerce.number().int().min(1).max(2_000).default(500)`
     - `mcpGatewayMaxSchemaBytes: z.coerce.number().int().min(1_024).max(262_144).default(65_536)`
     - `mcpGatewayMaxCatalogBytes: z.coerce.number().int().min(65_536).max(8_388_608).default(2_097_152)`
     - `mcpGatewayMaxTraceRows: z.coerce.number().int().min(100).max(1_000_000).default(20_000)`
     - `mcpGatewayMaxConnections: z.coerce.number().int().min(1).max(256).default(32)`
     - `mcpGatewayAllowInsecureHttp: enabled` (reuse the existing `enabled` preprocessor at line 7)
     - `mcpGatewayAllowPrivateEndpoints: enabled`
  2. In the existing `superRefine`, add hard guards so a misconfiguration cannot silently expose credentials:
     - in `cloudflare-access` mode, `mcpGatewayAllowInsecureHttp` **must be false** — issue a custom issue on `authMode`;
     - in `cloudflare-access` mode, `mcpGatewayAllowPrivateEndpoints` **must be false** — same;
     - in `owner-bearer` mode both may be true, and `allowInsecureHttp` additionally requires `allowPrivateEndpoints` (cleartext is only meaningful against a loopback/private target).
  3. In `loadApiConfig` map the nine `MCP_GATEWAY_*` variables.
  4. Document all nine in `.env.example` with defaults, and state plainly that **localhost and private targets are rejected unless `MCP_GATEWAY_ALLOW_PRIVATE_ENDPOINTS=true`**, that cleartext additionally requires `MCP_GATEWAY_ALLOW_INSECURE_HTTP=true`, and that both are refused in Cloudflare Access mode.
- **Success criteria:** `npm run typecheck -w @cloud-harness/api` exits 0; a `cloudflare-access` config with `mcpGatewayAllowInsecureHttp: true` fails schema validation.
- **Verify:** `npm run typecheck -w @cloud-harness/api` exits 0 and `npx vitest run packages/contracts/test/contracts.test.ts` exits 0.

### Task 2.2 — SSRF URL policy with socket pinning (write the test first)
- **Goal:** private, loopback, link-local, metadata, userinfo, query, and fragment URLs are rejected; the connection is pinned to the validated address.
- **Target files and symbols:** create `apps/api/src/mcp-gateway/url-policy.ts`; create `apps/api/test/mcp-gateway-url-policy.test.ts`.
- **Steps:**
  1. Test file first. Assert rejection of `http://example.com/mcp` (insecure disabled), `https://user:pass@example.com/mcp`, `https://localhost/mcp`, `https://127.0.0.1/mcp`, `https://10.0.0.5/mcp`, `https://100.64.1.1/mcp`, `https://172.16.4.4/mcp`, `https://192.168.1.1/mcp`, `https://169.254.169.254/latest/meta-data`, `https://[::1]/mcp`, `https://[::ffff:127.0.0.1]/mcp`, `https://[::ffff:7f00:1]/mcp`, `https://[fd00::1]/mcp`, `https://[::ffff:8.8.8.8]/mcp` (**must be accepted** — a mapped public address is public), `ftp://example.com/x`, `https://mcp.example.com/mcp?token=x`, `https://mcp.example.com/mcp#frag`, and a hostname resolving to `127.0.0.1` (resolver injected).
  2. Assert the private-target matrix is honoured by config: `https://127.0.0.1/mcp` is **accepted** when `allowPrivateEndpoints` is true, and `http://127.0.0.1:4123/mcp` is accepted only when **both** `allowPrivateEndpoints` and `allowInsecureHttp` are true.
  3. Assert acceptance of `https://mcp.example.com/mcp` and `https://example.com:8443/mcp`.
  4. Implement `validateGatewayEndpoint(rawUrl, { allowInsecureHttp, allowPrivateEndpoints, resolve? })`:
     - parse with `new URL`, reject on throw and on a raw value longer than 2,048 chars;
     - require `https:`, or `http:` only when `allowInsecureHttp` is true; reject every other protocol;
     - reject `url.username`, `url.password`, `url.search`, `url.hash`, and a raw `%2e`/`%2f`/`%5c` or backslash;
     - reject a hostname that is `localhost`, ends with `.localhost`, `.local`, `.internal`, `.home`, `.lan`, `.corp`, `.test`, `.invalid`, `.example`, `.arpa`, or equals `metadata.google.internal`;
     - classify an IP-literal host with `isUnsafeAddress`; when the host is not an IP literal, resolve with `node:dns/promises` `lookup(host, { all: true, verbatim: true })` and reject when the list is empty or **any** address is unsafe;
     - when `allowPrivateEndpoints` is false, require every resolved (or literal) address to be public; when it is true, skip only the public-address requirement and still reject `169.254.0.0/16` and `metadata.google.internal`;
     - return `{ ok: true, url, addresses }` so the caller can pin.
  5. Export `isUnsafeAddress(address)` with the **complete** block set (this is the semantic source of truth; the model gateway's equivalent is the reference implementation):
     - IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `>=224`;
     - IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `2001:2::/48`, `100::/64`;
     - unwrap IPv4-mapped IPv6 in **both** dotted (`::ffff:127.0.0.1`) and hex-word (`::ffff:7f00:1`) form, and classify the embedded IPv4;
     - strip an IPv6 zone id (`%eth0`) before classification;
     - **return `true` (fail closed) for anything that is not a valid IP literal.**
  6. Export `assertGatewayEndpoint(...)` throwing `HarnessError('INVALID_INPUT', message, 400, false)` with a sanitized message that never echoes the credential, query, or fragment.
  7. Do **not** import across apps from `apps/model-gateway`; this is an intentional, tested mirror with a comment naming the source of truth.
- **Success criteria:** the suite passes with no real DNS lookup; both `::ffff:127.0.0.1` and `::ffff:7f00:1` classify as unsafe and `::ffff:8.8.8.8` as safe.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-url-policy.test.ts` exits 0.

### Task 2.3 — Redaction helpers
- **Goal:** one place strips credential material from errors and log fields, including encoded forms.
- **Target files and symbols:** create `apps/api/src/mcp-gateway/redaction.ts`.
- **Steps:**
  1. `redactGatewayError(error, secrets = [])` → `{ code, message }`: `AbortError` → `CANCELLED`; `TimeoutError` or an SDK `RequestTimeout` → `TIMEOUT`; an SDK schema-validation error → `EXECUTION_FAILED` with a message saying the upstream declared a result schema it did not satisfy; a `HarnessError` keeps its code; an upstream HTTP 5xx → `UNAVAILABLE`, 4xx → `INVALID_INPUT`; anything else `EXECUTION_FAILED`. Cap at 500 chars and run through `sanitizeGatewayText`.
  2. `sanitizeGatewayText(text, secrets)`: replace every secret value with length ≥ 4 by its literal, `base64`, `base64url`, `hex`, and `percent-encoded` forms with `[REDACTED_SECRET]`, then rewrite any header-ish line matching `/^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)\s*:/im` so the value becomes `[REDACTED]`.
  3. `headerFingerprint(headers)`: a stable SHA-256 over the sorted resolved header values, used only for cache keying and never logged.
  4. `guardedFetchOptions(endpointUrl)`: returns the fetch wrapper used to attach credential headers only when the request origin and pathname equal the configured endpoint's; all other requests (SDK discovery, session DELETE, SSE resume) go out without the credential.
- **Success criteria:** neither the secret string nor its base64/hex/percent-encoded forms survives sanitization.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-catalog.test.ts` exits 0 (redaction assertions live there).

### Task 2.4 — Tool normalization + catalog/search
- **Goal:** cached tool metadata is well-formed, byte-bounded, and searchable.
- **Target files and symbols:** create `apps/api/src/mcp-gateway/catalog.ts`, `apps/api/src/mcp-gateway/types.ts`.
- **Steps:**
  1. In `types.ts` define `GatewayCatalog = { servers: McpGatewayServerView[]; tools: McpGatewayToolView[] }`, `GatewayToolMatch`, and `GatewayCatalogFilter = { serverId?: string; qualifiedName?: string }`.
  2. `normalizeUpstreamTools(server, tools, { maxTools, maxSchemaBytes })`: require a non-empty string `name` matching the upstream pattern; coerce a missing `description` to `''` and cap at 2,000 chars; serialize `inputSchema` verbatim **unless** its JSON byte length exceeds `maxSchemaBytes`, in which case store `{ type: 'object' }`, set `availability: 'unavailable'`, and set the description suffix `(schema omitted: exceeds the gateway schema limit)`, recording `schema_bytes`; keep `annotations` verbatim when it is an object; assign `id`, `serverId`, `serverName`, `qualifiedName` via `qualifiedToolName`; drop `qualifiedName` collisions (keep the first); apply `maxTools` by marking the overflow `unavailable` rather than dropping it.
  3. `searchTools(tools, query, { server, limit })`: lowercase tokenization on non-alphanumerics; score `3.0` per exact token in name/server, `1.5` per name prefix, `1.0` per description hit, `0.5` per server hit; require at least one hit; normalize the top score into `(0, 1]` rounded to 3 decimals; stable-sort by score desc then `qualifiedName` asc; cap at `limit` (default 5, max 25).
  4. `filterSearchable(catalog)`: return only tools whose server is enabled and whose **view `permission`** (the runner-supplied effective decision) is `allow`. Do **not** recompute permission in the API — the runner is the single source of truth, so `search`, `inspect`, and `execute` can never disagree.
  5. `estimateCatalogBytes(catalog)`: JSON byte length, used to enforce `mcpGatewayMaxCatalogBytes` before handing a catalog to a meta-tool (throw a `LIMIT_EXCEEDED` HarnessError naming the cap).
- **Success criteria:** `"website analytics traffic"` ranks a PostHog tool with that description above an unrelated GitHub tool; a disabled server's tools never appear; an oversized schema is stored as `unavailable`.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-catalog.test.ts` exits 0.

### Task 2.5 — Catalog tests
- **Goal:** normalization, caps, ranking, filtering, and redaction are covered.
- **Target files and symbols:** create `apps/api/test/mcp-gateway-catalog.test.ts`.
- **Steps:**
  1. `normalizeUpstreamTools` drops nameless tools, keeps a small `inputSchema` deep-equal to the fixture, replaces an oversized schema with `{ type: 'object' }` + `availability: 'unavailable'`, applies the `maxTools` cap by marking overflow unavailable, and builds `github.issue_create`-style names.
  2. Ranking order is deterministic across two runs and every `score` is in `(0, 1]`.
  3. `filterSearchable` excludes a disabled server and a tool whose view `permission` is `deny` but keeps its sibling.
  4. `redactGatewayError` maps a timeout to `TIMEOUT` and removes `Authorization: Bearer abc123` plus a resolved secret in raw, base64, hex, and percent-encoded form.
  5. `estimateCatalogBytes` flags a catalog above the cap.
  6. `validateGatewayEndpoint` accepts a public https URL and rejects `http://localhost` when insecure is disabled.
- **Success criteria:** the suite passes.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-catalog.test.ts` exits 0.

### Task 2.6 — Connection manager
- **Goal:** bounded, isolated, socket-pinned, lazily-cached downstream MCP connections that attach the credential only where it belongs.
- **Target files and symbols:** create `apps/api/src/mcp-gateway/connection-manager.ts`; add `"@modelcontextprotocol/client": "2.0.0"` and `"undici": "7.29.0"` to `apps/api/package.json` **dependencies**, then **run `npm install` and commit the regenerated `package-lock.json`** (the lockfile records `apps/api` dependencies; CI and the API image build both run `npm ci`, and `docker/api.Dockerfile` prunes dev dependencies, so the root-only devDependency is absent from the production image).
- **Steps:**
  1. Import `{ Client, StreamableHTTPClientTransport, SSEClientTransport }` from `@modelcontextprotocol/client`, and `{ Agent, fetch as undiciFetch }` from `undici` (importing the fetcher from the same package as the `Agent` avoids a dispatcher/version mismatch with Node's internal undici).
  2. **Pin the socket.** Build an `Agent` whose `connect.lookup` returns only the addresses returned by `validateGatewayEndpoint`:
     ```ts
     const agent = new Agent({ connect: { lookup: (_hostname, options, callback) => {
       if (typeof options === 'object' && options.all) callback(null, addresses);
       else callback(null, addresses[0].address, addresses[0].family);
     } } });
     ```
     The guarded fetcher runs `validateGatewayEndpoint` on every request URL, then calls `undiciFetch(url, { ...init, dispatcher: agent, redirect: 'error' })`. A resolver that answers public on validation and private on the transport's own lookup therefore cannot reach a private address.
  3. **Scope the credential.** Attach the resolved headers via the guarded fetcher only when the request origin and pathname equal the configured endpoint; every other SDK request (OAuth protected-resource discovery, session DELETE, SSE resume) is sent without them. Do not set `authProvider`.
  4. **Disable SDK output-schema validation.** Construct `new Client({ name, version }, { versionNegotiation: { mode: 'auto' }, jsonSchemaValidator: permissiveValidator })` where `permissiveValidator.getValidator()` returns a validator whose validate always succeeds. The SDK otherwise compiles the cached `tools/list` `outputSchema` and can throw *before or after* a call based on connection warmth, which would make `execute` non-deterministic. Pin this with a fixture whose `structuredContent` deliberately violates its declared `outputSchema`.
  5. Cache by `serverId` with `{ client, generation, headersFingerprint, connectedAt, lastUsedAt }`. Reuse only when `generation` and fingerprint match. Bound the cache to `maxConnections` with LRU eviction that calls `client.close()` and drops the header references. `size()` exposes the count for tests.
  6. `withConnection(server, headers, fn, signal)`: serialize per server so concurrent calls open one connection; **start the timeout after the caller acquires the server slot**, not while queued; combine `AbortSignal.timeout(timeoutMs)` with the caller signal via `AbortSignal.any`.
  7. **Distinguish caller-abort from transport failure.** If the caller's own signal aborted and our timeout did not fire, reject with `CANCELLED` **without evicting** the shared entry. Only a genuine transport error or our own timeout marks the entry unhealthy and evicts it, and exactly one waiter performs the reconnect (single-flight) with a short jittered backoff; the others wait for that attempt rather than each opening a connection. Never retry `fn`.
  8. `invalidate(serverId)` closes and evicts one entry; `health(serverId)` reports the cached state; `closeAll()` closes every client, clears the map, and **rejects pending waiters** with a typed `UNAVAILABLE` rather than leaving them to hang.
  9. Reject a response whose `content-length` exceeds `maxResponseBytes` and stream-limit the body otherwise.
  10. A failure for one server must not evict or reject another server's cache entry.
- **Success criteria:** two concurrent calls for one server open exactly one connection; a caller-abort does not evict a healthy entry used by another caller; a failing server leaves a healthy server's entry intact; the cache never exceeds `maxConnections`.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-connection.test.ts` exits 0.

### Task 2.7 — Connection tests
- **Goal:** connect, discover, header scoping, isolation, reconnect, timeout, abort, redirect, eviction, and shutdown are covered.
- **Target files and symbols:** create `apps/api/test/mcp-gateway-connection.test.ts`.
- **Steps:**
  1. Inject a fake `fetchImpl` answering MCP Streamable HTTP JSON-RPC (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`) deterministically, and assert a successful `listTools`.
  2. Assert a second call within the TTL reuses the cached client (exactly one `initialize`).
  3. Assert the credential header appears on requests to the configured endpoint path and **not** on a discovery-style request to another path on the same origin.
  4. Assert a rejecting server does not prevent a second server from connecting and does not evict the healthy entry.
  5. Assert `invalidate(serverId)` forces a new `initialize`.
  6. Assert a hung `fetchImpl` yields `TIMEOUT` within roughly `timeoutMs`.
  7. Assert a caller-signal abort yields `CANCELLED` and leaves the cached entry in place, while an upstream transport failure evicts it and the next call performs exactly one reconnect.
  8. Assert a `redirect: 'manual'` 301 response surfaces as a normalized error whose message names redirects, not a bare `UNAVAILABLE`.
  9. Assert creating more servers than `maxConnections` evicts the least-recently-used entry (its client is closed and `size()` stays at the cap).
  10. Assert `closeAll()` closes every client, and a pending waiter receives `UNAVAILABLE` instead of hanging.
  11. Assert a permissive output-schema client returns `structuredContent` for a tool whose declared `outputSchema` does not match, rather than throwing.
- **Success criteria:** the suite passes offline with no real network access.
- **Verify:** `npx vitest run apps/api/test/mcp-gateway-connection.test.ts` exits 0.

## Verification

```bash
npm ci
npm run build -w @cloud-harness/contracts
npm run typecheck -w @cloud-harness/api
npx vitest run apps/api/test/mcp-gateway-url-policy.test.ts apps/api/test/mcp-gateway-catalog.test.ts apps/api/test/mcp-gateway-connection.test.ts
```

Success: `npm ci` succeeds (proving the lockfile is in sync), every command exits 0, the
three suites report zero failed tests, and the connection suite makes no real network request.

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
shapes, internal helper splits, and cache-eviction bookkeeping. **What you must escalate**:
any change to a frozen interface, any verification failure, any weakening of the SSRF or
credential-scoping controls, and any `npm ci` failure.
