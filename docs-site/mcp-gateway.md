---
title: MCP Gateway
description: Connect one Cloud Harness endpoint that manages every MCP server you configure.
---

# MCP Gateway

The **MCP Gateway** is a second Cloud Harness MCP endpoint that fronts the
downstream MCP servers you register yourself — GitHub, PostHog, Supabase,
Cloudflare, or any other remote MCP server. Instead of adding each of those
servers to Claude, ChatGPT, Codex, and Cursor separately, you configure one URL
in each client:

```text
https://<your-cloud-harness-host>/mcp-gateway
```

Cloud Harness keeps your registry, cached tool metadata, permissions, and logs.
Your MCP client talks only to Cloud Harness; Cloud Harness talks to the
downstream servers.

::: tip One endpoint, a constant tool list
The gateway always exposes exactly five tools — `search`, `inspect`, `execute`,
`permissions`, and `status` — no matter how many downstream tools you configure.
Your client's context window does not grow as you add servers.
:::

## Add an MCP server

1. Open the [Operator Dashboard](/dashboard/) and go to **MCP Servers**.
2. Select **Add MCP server** and provide:
   - **Name** — a short lowercase identifier, unique to you, such as `github`.
   - **Transport** — `streamable-http` or `sse`.
   - **Endpoint** — the server's MCP URL, usually ending in `/mcp`.
   - **Headers** — any custom headers the server requires, such as an
     `Authorization` header.
   - **Default permission** — `allow` or `deny` for every tool on that server.
3. Save the server. Use **Test** to confirm Cloud Harness can reach it, and
   **Refresh tools** to cache the server's tool list.

Enable, disable, edit, and delete servers from the same list. Deleting a server
also deletes its cached tools, permissions, and recorded logs.

## Reference a secret instead of pasting one

A header value can be a literal or a reference to one of your
[global secrets](/dashboard/secrets):

```text
Authorization: Bearer <literal value>
Authorization: { secretRef: my-vendor-token }
```

A secret reference stays write-only. The dashboard shows only the secret name,
the resolved value is never stored in the server configuration, and it is never
returned to the browser, a tool result, a trace, or a log. Cloud Harness attaches
the resolved credential only to requests for that server's configured endpoint.

If the referenced secret is missing, the gateway tells you which reference is
unavailable — never a value.

## Connect an MCP client

Point the client at `https://<your-cloud-harness-host>/mcp-gateway`. The gateway
uses the same authentication as your `/mcp` endpoint: your Cloudflare Access
session in Access mode, or your owner bearer token in owner-bearer mode.

::: warning Credential lanes
The managed **API-key lane** (`https://api.harness.zuey.me/mcp`) is not available
for `/mcp-gateway`. Clients configured with a dashboard-managed API key keep
using `/mcp`.
:::

## Find and run a tool: search, inspect, execute

The gateway does not dump every downstream tool into your client's tool list.
Work through it in three steps:

1. **`search`** — describe what you want to do, for example "create a GitHub
   issue". You get back qualified tool names in the form
   `<server>.<tool>`, ranked and filtered to tools you are allowed to use.
   Optionally restrict the search to one server.
2. **`inspect`** — pass one qualified name to receive that tool's real input
   schema, annotations, availability, and effective permission. Read the schema
   before you call it.
3. **`execute`** — run the tool with arguments that match the inspected schema.
   Cloud Harness re-checks permission at execution time and routes the call
   server-side. A mutating call is never automatically retried.

Two more tools round out the surface:

- **`permissions`** — show the effective allow/deny decision for one tool, for
  every tool on a server, or for every configured server.
- **`status`** — show each server's enabled state, connection state, cached tool
  count, last successful connection, and a sanitized error when one is stored.

## Permissions

Each server has a default permission (`allow` or `deny`), and any individual
tool can override it with the opposite decision. The effective decision is the
tool override when one exists, otherwise the server default. Permission is
enforced on every execution, not only when you browse tools. Only `allow` and
`deny` exist — there is no approval prompt state.

**Default permission is `allow`.** A newly added server's tools are immediately
executable with your credential, which is a deliberate usability decision for a
single-owner harness. If you want default-deny, set `permissionDefault: deny` on
the server; a deny-by-default server stays testable because **Test** and
**Refresh tools** use the separate, audited `connect` credential purpose instead
of the execution gate.

**Test** and **Refresh tools** always work, even on a deny-by-default server,
because they use a separate, audited connection purpose that only proves
reachability.

## Logs

Every gateway call writes a trace you can review in the server's **Logs** tab: the
time, the tool, the outcome, the duration, when the client identified itself, and
the request and response sizes. Argument and result contents are not stored, and
credential values are removed. Logs are bounded by a retention cap, and deleting
a server deletes its logs.

## Supported downstream transports

| Transport | Supported | Notes |
|---|---|---|
| `streamable-http` | Yes | The standard remote MCP transport. Supports a secret-reference header. |
| `sse` | Yes | Legacy remote SSE transport. Literal headers only; a secret-reference header is rejected at save time. |
| `stdio` | No | Cloud Harness does not run package-based local MCP servers. |

OAuth-protected downstream servers are not supported; use a header secret
reference instead.

## Limitations

- **HTTP redirects are refused.** If your vendor's base URL redirects, configure
  its final URL directly.
- **`stdio` servers are unsupported.** Use `streamable-http` or `sse`.
- **OAuth-protected downstream servers are unsupported.** Use a header secret.
- **The managed API-key lane is not available.** Use Access or the owner bearer.
- **Connections are per-process and bounded.** They are not shared across API
  replicas and are rebuilt after a restart.
- **Search is lexical, not semantic.** It matches words and names; it is not an
  embedding search.
- **Only `allow` and `deny`.** There is no `confirm` decision.
- **Deleting a server deletes its logs.**
- **Schema size is capped.** A downstream tool whose schema is too large is
  reported as unavailable rather than truncated.
- **Authenticated SSE servers are unsupported and refused when you save them.**
  Your credential is attached only to requests whose origin and pathname equal
  your configured endpoint, so an SSE server that needs a header credential on
  its separate message/POST endpoint never receives one. Saving `sse` with a
  secret-reference header fails immediately and tells you to use a Streamable
  HTTP server, so the mistake cannot pass Test/Refresh and fail on real calls.
- **`status` and `permissions` read the whole catalog.** Only `search` needs to by
  design; `inspect` and `execute` load a single tool.
