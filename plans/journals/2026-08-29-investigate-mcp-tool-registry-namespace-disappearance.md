# Technical Journal: Investigation of MCP Tool Registry Disappearance in Remote AI Sessions

**Date:** 2026-08-29  
**Domain:** Control Plane / Streamable HTTP MCP & Remote Connector Discovery  

## 1. Problem Context & Symptoms

In multi-turn, multi-connector ChatGPT / remote AI sessions with CloudHarness connected via Managed OAuth, operators reported that the `CloudHarness.*` tool namespace could vanish from the model's active tool registry mid-conversation (`No tool was defined under the given paths...`), while the ChatGPT plugin settings continued to report `status: found, app_permission: Allow all actions`.

## 2. Protocol Boundary & Root Cause Diagnosis

A deep inspection of the control plane, `@modelcontextprotocol/server` 2.0.0 integration, and RFC 6750/9110 HTTP authentication boundaries established the following failure boundaries:

1. **Client-Owned Registry Lifecycle:** The active tool namespace registry and tool re-discovery loops are 100% owned by the external client orchestration runtime (ChatGPT). When an external client encounters a transport-level disconnection, idle timeout, or transient token expiry, the client drops the active tool namespace from the prompt context without initiating a transparent reconnect or `tools/list` handshake.
2. **Server-Side Invariants & HTTP Error Semantics:** Pre-dispatch middleware rejections (HTTP 401 `WWW-Authenticate: Bearer realm="cloud-harness-mcp"`, HTTP 429 `rate_limited` with `Retry-After`, HTTP 415 `unsupported_media_type`) occur at the transport boundary before JSON-RPC dispatch. Attempting to format pre-dispatch HTTP 401/429 errors as JSON-RPC payloads violates HTTP authentication RFCs and breaks contract test suites.
3. **Server Health & Tool Registration:** The CloudHarness MCP server statelessly registers and serves all 40 `TOOL_SPECS` across all requests without leakage, memory corruption, or tool unregistration.

## 3. Operational Guidance & Mitigation

For operators using CloudHarness with ChatGPT and other OAuth-based AI clients:
- **Tuning OAuth Grant Duration:** In Cloudflare Zero Trust → Access Controls → Applications → edit the MCP application → **Advanced settings → Managed OAuth**, set **Grant session duration** to 1–4 weeks (while keeping Access token lifetime at 15 minutes) to ensure silent OAuth refresh throughout conversations.
- **Static API Key Gateway for Zero-Reauth:** For automated CLI/coding agents, connect directly to `https://api.harness.zuey.me/mcp` using a long-lived API key from `/dashboard/api-keys` (valid for 1–3,650 days) to completely eliminate interactive OAuth session drops.
- **Recovery:** If an AI client unregisters the namespace mid-session, starting a new chat turn or toggling the connector forces a fresh handshake.

## 4. Verification

- All 58 test files and 410 unit/integration tests passed.
- Full repository verification gate (`npm run verify`: plugin check, lint, multi-workspace typecheck, unit/integration tests, and worker build) succeeded cleanly.
