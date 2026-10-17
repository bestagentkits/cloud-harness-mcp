# MCP gateway

The MCP gateway is a second Streamable HTTP composition root at
`https://<host>/mcp-gateway`. It fronts the downstream MCP servers a principal
registers and exposes them through five constant meta-tools instead of
aggregating every downstream tool into `tools/list`.

## What it is

`/mcp` remains the coding-harness surface with its native tool set. The gateway
is a separate surface with a separate purpose:

- **One URL per client.** A principal configures `https://<host>/mcp-gateway`
  once and reaches every MCP server they have registered.
- **A constant-size tool surface.** `search`, `inspect`, `execute`,
  `permissions`, and `status` are the only tools the gateway ever advertises,
  whether the registry holds 5 or 5,000 downstream tools.
- **A principal-scoped registry.** Servers, cached tool metadata, permission
  decisions, traces, and secret references belong to the authenticated
  principal. One principal can never see, discover, inspect, execute against, or
  read the logs of another principal's servers.

The runtime split is deliberate:

- **The runner owns** registry persistence, cached tool metadata, the
  allow/deny decision, traces, and encrypted-secret resolution. It already owns
  SQLite, the keyring, and the audit trail. The gateway tables
  (`mcp_gateway_servers`, `mcp_gateway_tools`,
  `mcp_gateway_tool_permissions`, `mcp_gateway_traces`) were introduced by
  runner-owned metadata schema v6; v7 adds the encrypted downstream OAuth
  grant and pending-flow tables (`mcp_oauth_grants`, `mcp_oauth_flows`).
- **The API owns** the MCP client role: the outbound socket to
  principal-configured URLs. The API is the internet-facing,
  Docker-socket-free, host-mount-free component with the dedicated egress
  network. The runner holds the Docker socket and host mounts, so putting
  arbitrary user-URL egress there would move SSRF reachability into the most
  privileged component.

The runner resolves a server's referenced credentials for the API over the
existing service-token internal channel; it never dials a configured URL
itself, and it refuses to resolve credentials for a denied tool. The security
consequences of that one boundary expansion are recorded in the
[security model](security-model.md).

Executable owners:

- Contracts for servers, tools, traces, permissions, transports, and credential
  resolution: [`packages/contracts/src/mcp-gateway-schemas.ts`](../packages/contracts/src/mcp-gateway-schemas.ts)
- Registry, tool cache, permission decisions, traces, and retention:
  [`apps/runner/src/mcp-gateway-store.ts`](../apps/runner/src/mcp-gateway-store.ts)
- Encrypted downstream OAuth grants and single-use pending flows:
  [`apps/runner/src/mcp-oauth-store.ts`](../apps/runner/src/mcp-oauth-store.ts)
- Gateway schema migrations and downgrade ladder:
  [`apps/runner/src/metadata-schema.ts`](../apps/runner/src/metadata-schema.ts)
- Gateway assembly, meta-tools, catalog, connection manager, URL policy,
  redaction, and the downstream OAuth client (`oauth-flow.ts`,
  `oauth-provider.ts`, `oauth-fetch.ts`):
  [`apps/api/src/mcp-gateway/`](../apps/api/src/mcp-gateway/)
- Endpoint and route wiring:
  [`apps/api/src/app.ts`](../apps/api/src/app.ts)
- Dashboard connection/test/refresh and OAuth status/start/disconnect/callback
  routes:
  [`apps/api/src/dashboard-gateway-router.ts`](../apps/api/src/dashboard-gateway-router.ts)

## How to add an MCP server

Add and manage servers in the dashboard **MCP Servers** section
(`/dashboard/mcp-servers`). A server record carries a lowercase name that is
unique per principal, an optional description, a transport, the endpoint URL,
custom headers, optional [downstream OAuth](#downstream-oauth) configuration,
a server-level default permission, and an enabled flag. The dashboard also
offers Test, Refresh tools, enable/disable, delete, and, for an OAuth server,
Connect and Disconnect.

The field set, validation, and bounds are owned by
[`packages/contracts/src/mcp-gateway-schemas.ts`](../packages/contracts/src/mcp-gateway-schemas.ts);
updates are generation-checked, so a stale edit is rejected instead of
silently overwriting a concurrent change.

**Test** and **Refresh tools** use the API-side connection manager to reach the
server and cache its `tools/list` metadata. Both are explicitly audited as the
`connect` credential purpose, so a deny-by-default server stays testable.

## How secrets are referenced

A header value is either a literal or a reference to an existing dashboard
global secret:

```json
{ "name": "Authorization", "value": { "secretRef": "vendor-mcp-token" } }
```

- The reference is resolved from the principal's existing global secrets. The
  resolved value is never stored in server configuration and never projected
  back to the browser: the dashboard shows only the secret name and a
  write-only marker.
- Resolution is scoped by an explicit purpose. `execute` is gated by the cached
  tool's effective permission and is refused for a disabled server or a denied
  or unknown tool. `connect` is the server-level grant used by Test and
  Refresh.
- Every resolution is audited as `mcp_gateway.credentials_resolved` with the
  server, purpose, and header count. No value reaches the audit trail.
- The API attaches resolved headers only to a request whose origin and pathname
  equal the configured endpoint's — the MCP requests the server is configured
  for. A request to a different origin or path, including a redirect target, a
  discovery probe, or an OAuth metadata fetch, goes out without them.
- A missing reference fails with `NOT_FOUND` naming the reference, never a
  value.

## How to connect an MCP client

Configure the client with one URL:

```text
https://<host>/mcp-gateway
```

The gateway accepts the same authentication contracts as `/mcp`: a verified
Cloudflare Access assertion in `cloudflare-access` mode, or the owner bearer in
`owner-bearer` mode. It is served by the same nginx exact-location set and must
be covered by the same Access application that protects `/mcp`. The
[deployment guide](deployment.md) records the route and the required upgrade
order.

Clients that can only send a static header use the managed **API-key lane**
instead: `https://api.harness.zuey.me/mcp-gateway` with a dashboard-managed key
as the bearer. The Worker forwards that one public path to the hidden origin
route `/mcp-api-key/gateway`, which sits under the existing `/mcp-api-key`
prefix so the same path-scoped Service Auth Access application and the same
dual-credential check (Worker service assertion plus principal-bound managed
key) protect it; no Access change is needed. It serves the same five meta-tools
scoped to the key's bound principal. Managed keys are still rejected on
`/mcp-gateway` itself, and human assertions are still rejected on the API-key
routes. The route exists only in `cloudflare-access` mode with the API-key lane
enabled. Owners: the path table in
[`apps/api-key-gateway/src/gateway.ts`](../apps/api-key-gateway/src/gateway.ts)
and the `/mcp-api-key` mount in [`apps/api/src/app.ts`](../apps/api/src/app.ts).

## Progressive tool discovery

Tools are not aggregated into `tools/list`. The gateway advertises exactly five
meta-tools and discloses downstream tools one step at a time:

1. `search` finds a qualified name (`<server>.<tool>`) from a description of
   what you need. It is lexical/fuzzy matching, permission-filtered, and
   optionally restricted to one server. When the `mcp-routing` Decision Plane
   purpose is on, the lexical pool is reranked semantically. The response then
   reports `ranking: "semantic"` and a `decisionId`; otherwise it reports
   `ranking: "lexical"`. A rerank can only reorder tools already in the
   permission-filtered pool
   ([ADR 0004](adr/0004-decision-plane.md)). A search whose pool holds two or
   more tools asks the runner for a rerank on every call, so it costs one
   internal round-trip even when the purpose is off or the owner has no key;
   the runner answers those cases at once without contacting the provider.
2. `inspect` returns that one tool's real upstream input schema, annotations,
   availability, and effective permission.
3. `execute` routes one call with arguments matching that schema, re-checks
   permission at execution time, enforces the gateway timeout, and never
   auto-retries.
4. `permissions` reports the effective allow/deny decision for a tool, for every
   tool on a server, or for every configured server.
5. `status` reports each server's enabled state, connection state, cached tool
   count, last successful connection, and a sanitized error when one is stored.

The input schemas and annotations for those five tools are owned by
[`apps/api/src/mcp-gateway/meta-tools.ts`](../apps/api/src/mcp-gateway/meta-tools.ts).
The gateway surface is not part of the public `TOOL_SPECS` inventory and does
not appear in the generated tools reference.

## Permissions

Each server has a default decision, and any individual tool may override it.
The effective decision is the tool override when one exists, otherwise the
server default. Only `allow` and `deny` exist; there is no `confirm` state.

`permissionDefault` defaults to `allow`, so a newly added server's tools are
immediately executable with the principal's credential. That is a deliberate
usability decision for a single-owner harness; an operator who wants
default-deny sets `permissionDefault: deny` on the server, and a
deny-by-default server stays testable because Test and Refresh use the audited
`connect` credential purpose instead of the `execute` gate.

The runner is the sole permission authority and re-evaluates the decision on
every `execute` call, not only in the API. A denied tool is excluded from
`search` and cannot execute. The API never recomputes a decision from its own
copy of the policy.

## Logs and traces

Every gateway operation writes a trace row through the runner. A trace records
the trace id, timestamp, principal, client identity when the client supplied
one, server, tool, operation, duration, outcome (`success`, `error`, or
`denied`), request and response byte sizes, and a sanitized error code and
message.

Captured content is intentionally metadata-only:

- Downstream arguments and results are never stored; only their byte sizes are.
- Resolved credential values are scrubbed from errors and text the API
  surfaces, including encoded forms, and are never written to a trace or log.
- Stored errors are sanitized before they are persisted.

Trace rows are bounded by `MCP_GATEWAY_MAX_TRACE_ROWS`; the oldest rows are
evicted. Deleting an MCP server deletes its cached tools, tool permissions, and
recorded traces with it.

## Supported downstream transports

- `streamable-http` and `sse` are accepted.
- `stdio` is **not supported** and is rejected with `INVALID_INPUT` naming the
  unsupported transport. A stdio server needs a command, an interpreter, and
  package acquisition inside a Cloud Harness container, which is the
  package/runtime subsystem this feature deliberately excludes.
- `sse` accepts literal headers only. Saving an `sse` server with a
  secret-reference header is rejected at create/update time; the credential can
  only be attached to the configured endpoint, and an SSE server's JSON-RPC POST
  goes to a separate message path. Use `streamable-http` when a header credential
  is required.
- OAuth-protected downstream servers are supported on `streamable-http` only;
  see [Downstream OAuth](#downstream-oauth).

## Downstream OAuth

Cloud Harness can act as an OAuth 2.1 client (MCP Authorization) to a
downstream remote MCP server that requires it. This is the **outbound** lane:
Cloud Harness authenticating *to* a third-party server. It is unrelated to the
**inbound** Cloudflare Access Managed OAuth lane that authenticates AI clients
*to* Cloud Harness; the two share no client registration, redirect URI,
token, or configuration.

Why it exists: many hosted MCP servers no longer issue static API tokens, so a
header secret reference cannot reach them. The design keeps the gateway's
existing boundaries rather than adding a new credential path:

- **Configuration is separate from the grant.** A server's optional `oauth`
  object (`scopes`, `clientId`, `clientSecretRef`) is ordinary,
  generation-checked server configuration, owned by
  `McpGatewayOAuthConfigSchema` in
  [`packages/contracts/src/mcp-gateway-schemas.ts`](../packages/contracts/src/mcp-gateway-schemas.ts).
  The client secret of a manually registered client is a write-only reference
  to a global secret, exactly like a secret header. Tokens, registered client
  information, and discovery state live only in the runner's encrypted grant,
  never in a server view.
- **OAuth owns the `Authorization` header.** Saving a server with OAuth and a
  custom `Authorization` header, or with OAuth on `sse`, is refused at write
  time, including when a partial update would combine them with stored
  fields.
- **Authorization is explicit and browser-driven.** Only the dashboard
  **Connect** action starts a flow; the browser returns to
  `/dashboard/mcp-oauth/callback`, which trusts nothing but the one-time
  `state` and redirects back to the server detail page with an `oauth=connected`
  or `oauth=error&reason=…` marker. Background Test, Refresh, and `execute`
  never open a browser and never create state at an authorization server: they
  may only use or refresh an existing grant. Without a usable grant they fail
  with the structured `AUTHORIZATION_REQUIRED` code so the dashboard can offer
  Connect or Reauthorize. A failed or declined Connect, Reconnect, or
  Reauthorize never touches the stored tokens, so a grant that still works
  stays `connected` (or `reauthorization_required`) and only records the
  failure as `lastError`.
- **Grants are principal-scoped and bound to what they were issued for.**
  Changing the endpoint or the manual client, or turning OAuth off, discards
  the stored grant locally; deleting the server deletes it. **Disconnect**
  attempts revocation best effort and deletes the grant regardless of the
  revocation outcome.
- **Client registration prefers the least operator setup.** A manually entered
  `clientId` is used as given. Otherwise Cloud Harness uses a Client ID
  Metadata Document when `MCP_DOWNSTREAM_OAUTH_CLIENT_METADATA_URL` is set and
  the authorization server advertises support, and falls back to dynamic
  client registration. A server that supports neither needs a manual client.
- **Deployment opt-in.** Connect is unavailable until
  `MCP_DOWNSTREAM_OAUTH_REDIRECT_URL` is set; see
  [configuration](configuration.md#downstream-mcp-oauth). Until then the
  status reads `not_configured` and the dashboard offers no Connect; an
  existing connected grant keeps working in the background and can still be
  disconnected. Because the dashboard is served only in `cloudflare-access`
  mode, the callback is too. The shipped nginx and Caddy configurations keep
  the callback's one-time `code` and `state` out of their access logs.

The state names, status fields, and transitions are owned by
`McpGatewayOAuthStateSchema` and `McpGatewayOAuthStatusSchema` in the
contracts file above and by
[`apps/runner/src/mcp-oauth-store.ts`](../apps/runner/src/mcp-oauth-store.ts).
The security properties (PKCE, state binding, issuer and resource checks,
encryption, hardened OAuth fetch, audit) are recorded in the
[security model](security-model.md#downstream-mcp-oauth-client). Behavioural
evidence is in [`apps/api/test/mcp-oauth.test.ts`](../apps/api/test/mcp-oauth.test.ts)
and [`apps/runner/test/mcp-oauth-store.test.ts`](../apps/runner/test/mcp-oauth-store.test.ts).

## Dependencies

The gateway adds `@modelcontextprotocol/client` and `undici` as runtime
dependencies of the API. Because [`docker/api.Dockerfile`](../docker/api.Dockerfile)
prunes dev dependencies from the production image, the client also pulls
`eventsource`, `eventsource-parser`, `cross-spawn`, `jose`, and
`pkce-challenge` into that image.

This is accepted because the client is the maintained implementation of the
protocol the gateway speaks, and the transitive packages are small and
widely deployed. The `eventsource` stack parses untrusted downstream SSE
streams, so it is treated as an input boundary: the URL policy, the
connect-time socket pinning, the endpoint-scoped header attachment, and the
response byte caps exist partly to bound what a hostile downstream server can
cause to be parsed or returned. They are defense in depth, not a claim that the
parser is safe against a hostile stream.

## Known limitations

- `stdio` downstream transports are unsupported (no package/runtime subsystem).
- Downstream OAuth is `streamable-http` only, requires the deployment redirect
  URL, and is connected per principal from the dashboard; an MCP client cannot
  start an authorization through the gateway tools.
- **HTTP redirects are refused.** A vendor base URL that 301s to `/mcp` must be
  configured as its final URL.
- Connection pooling is per-process, bounded by `MCP_GATEWAY_MAX_CONNECTIONS`
  with least-recently-used eviction, and not shared across API replicas.
- Search is deterministic lexical/fuzzy matching, not embeddings.
- `confirm` permissions are not implemented; only `allow` and `deny`. Test and
  Refresh use the explicit, audited `connect` credential purpose so a
  deny-by-default server stays testable.
- Deleting an MCP server deletes its recorded logs with it.
- Downstream schema shape varies between servers. `inspect` returns the upstream
  schema unmodified; a schema over `MCP_GATEWAY_MAX_SCHEMA_BYTES` is cached as
  `unavailable` rather than truncated.
- **Authenticated SSE is unsupported and rejected at write time.** The resolved
  credential is attached only to a request whose origin and pathname equal the
  configured endpoint, so an SSE server that requires a header credential on its
  separate message/POST endpoint never receives one. Saving `transport: 'sse'`
  with a secret-reference header fails with `INVALID_INPUT` and names
  `streamable-http` as the supported transport, before the server can be stored
  and before Test/Refresh can report a false success.
- `status` and `permissions` read the whole principal catalog (only `search` needs
  to by design); `inspect` and `execute` fetch a single tool.
