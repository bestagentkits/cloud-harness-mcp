---
phase: 4
title: "Cloudflare Worker API-key gateway"
status: completed
priority: P1
effort: "1-1.5d"
dependencies: [2]
---

# Cloudflare Worker API-key gateway

## Context links

- [Plan](./plan.md)
- [Topology](../../docs/system-architecture.md)
- [Deployment](../../docs/deployment.md)
- [Compose verifier](../../scripts/verify-compose-boundaries.mjs)

## Overview

Create a minimal Worker workspace for `api.harness.zuey.me/mcp`. It is a fixed streaming proxy, not a key database: accept ordinary Bearer, discard spoofable metadata, inject only its origin Access service token.

## Requirements and architecture

- Add `apps/api-key-gateway/` TypeScript workspace with source, tests, typecheck/build, and secret-free Wrangler manifest.
- Bind exact public `/mcp` and only MCP-required methods. Reject other paths/methods with bounded non-HTML responses; no dashboard, health, arbitrary proxy, or dynamic upstream.
- Fixed HTTPS upstream ends at exact `/mcp-api-key`; reject redirects and never derive host/path from caller data.
- Reconstruct outgoing headers from an allowlist needed for Streamable HTTP: Authorization, content negotiation/type, MCP protocol/session/event IDs, and only justified bounded tracing.
- Never copy the incoming Headers object. Thus caller `Cf-*`, `Cf-Access-*`, `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, service-token, Host, hop-by-hop, and cache headers are discarded. Inject Worker-owned Access headers afterward.
- Stream bodies without buffering/transformation. Disable caching, body/auth logging, analytics capture, and exception body dumps. Preserve only safe MCP response headers.
- Store service-token values as Worker secrets only. Use distinct preview/production credentials and exact Service Auth policy for this Worker token.
- Protect the hidden origin path with a separate, exact path-scoped Access application and unique audience; never add the Worker token to the main `/mcp`/dashboard application's policies.
- Add a manifest-owned aggregate Cloudflare Rate Limiting binding (600 requests per 60 seconds per Cloudflare location) that returns bounded `429` on exhaustion and fails closed when unavailable; origin per-credential limits remain authoritative.

## Related files

- Create Worker workspace package, TypeScript config, source, tests, secret-free manifest.
- Modify root scripts/lockfile/CI to include Worker verification without live credentials.
- Modify deploy verification for second hostname, host nginx exact hidden route, credential-free ingress exact hidden route, and associated boundary assertions.
- Do not change Compose networks or publish API/runner ports.

## Implementation steps

1. Test exact route/method, header allowlist, injection, fixed upstream, redirects, streaming/SSE, limiter exhaustion/failure, errors, and cache.
2. Implement smallest proxy with dependency-injected upstream fetch.
3. Add secret-name checks and leak scans; fixtures use `[redacted]` only.
4. Integrate build/typecheck/test into root verification.
5. Deploy preview and run sanitized key-through-Worker canary.

## Success criteria

- [x] G1, G3, G7, and G11 have automated coverage; G13 has named Phase 6 canaries.
- [x] Spoofed Cloudflare/forwarding/service headers never reach origin.
- [x] Worker cannot proxy another origin/path or dashboard traffic.
- [x] Worker secrets stay out of repository, CI, logs, snapshots.

## Risks and rollback

The Worker is public, so bounded errors and layered limits are mandatory. Remove/disable its route first; hidden origin remains protected by exact service assertion and is disabled independently.

## Unresolved questions

None.
