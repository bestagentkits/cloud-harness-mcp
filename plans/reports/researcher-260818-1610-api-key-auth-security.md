---
title: Dashboard-managed API key authentication security research
date: 2026-08-18T16:10:00+07:00
status: complete
scope: Cloudflare Access-protected MCP and static-key clients
---

# Dashboard-managed API key authentication security research

## Summary

Recommend provisioning **Cloudflare Access service tokens**, not origin-verified
opaque bearer keys. Access can accept a service token in one configured header;
Cloudflare creates a client ID/secret pair, shows the secret once, verifies every
request at the edge, and forwards a signed application JWT. This preserves the
existing no-bypass invariant while supporting clients able to set one exact
header value. [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

Critical compatibility gate: the one-header value is JSON containing both
Cloudflare fields, not `Bearer <opaque-key>`. Confirm Dewee can send this exact
`Authorization` value. If it forces Bearer syntax, do not open an unprotected
hostname/path or accept that bearer at origin; retain Managed OAuth or make the
separate Workers OAuth-provider decision already required by
[`docs/deployment.md`](../../docs/deployment.md).

## Recommended trust flow

```text
human Access identity -> dashboard -> runner-only Cloudflare broker -> service token
static client -> Access edge -> signed JWT -> origin mapping -> principal operation
```

Use a dedicated Service Auth policy. Configure
`read_service_tokens_from_header: Authorization`; the client sends the exact
Cloudflare JSON value. Keep the hostname-wide Access application protecting
both `/mcp` and `/dashboard`. Direct-to-origin traffic still fails because the
origin requires a valid issuer/audience/signature/expiry Access assertion.

Cloudflare service JWTs have empty `sub`; `common_name` is the service token
client ID. The current verifier already normalizes this shape, but automatic
creation of a new external principal is unsafe for dashboard keys. Require an
active local mapping from verified `common_name` to the creating human's durable
principal. Unknown service IDs fail closed. [Application-token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)

## Key lifecycle and storage

- Generate through a runner-only broker. Give its API credential only
  account-scoped `Access: Service Tokens Write`; never expose it elsewhere.
- Return client ID + secret only in the successful `no-store` create response.
  Use transient DOM state; no storage, analytics, replay, or later recovery.
- Do **not** persist or hash the Cloudflare client secret locally: origin never
  verifies it. Store `credential_id`, Cloudflare token ID, client ID,
  `principal_id`, label, state/generation, created/expires/revoked timestamps,
  and coalesced last-used metadata. Client ID is an identifier, not a secret.
- If a future edge verifier issues native high-entropy `Bearer chm_...` keys,
  store only a versioned keyed hash (HMAC with a separately held pepper), use a
  public lookup prefix plus constant-time verification, and show plaintext once.
  Password KDFs address low-entropy memorized secrets; a CSPRNG-generated token
  should instead have enough entropy to resist guessing. This alternative is
  out of scope until the edge can authenticate it without bypass.
- Expiry is mandatory and bounded; no `forever` default. Rotation creates a new
  credential, allows an explicit overlap window, then revokes the old one.
  Bearer credentials are replayable, so TLS, audience restriction, scoping and
  short lifetime reduce exposure. [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html)

## Ownership and consistency

- Create/list/rotate/revoke queries always include the authenticated human
  principal. Never select by email/name and never permit cross-principal IDs.
- Prefer a preconfigured `any valid service token` Service Auth policy plus the
  origin mapping gate. This avoids granting runtime policy-write authority and
  policy-update races. Its safety depends on unknown client IDs being denied,
  not auto-enrolled.
- Create: record intent/idempotency key; call Cloudflare; transactionally store
  mapping; return plaintext once. If the response is lost, never replay/store
  the secret: revoke and recreate. Reconcile reserved-name Cloudflare tokens
  with no local mapping as denied orphans and delete them.
- Revoke: transactionally mark local state `REVOKING` first so origin denies
  immediately, then delete at Cloudflare, then mark `REVOKED`. Retry/reconcile
  failed or uncertain deletes by Cloudflare token ID. Cloudflare says deletion
  prevents future service-token access.
- Configure Service Auth so the credential is presented every request. Access
  notes that reusable JWT sessions are available when an Allow policy exists;
  the local active-record check must still reject a revoked mapping.
- Avoid positive authorization caches initially. The runner's single SQLite
  record can be checked per operation. If later measured necessary, use
  generation-tagged entries, explicit invalidation, very short TTL, and
  fail-closed behavior on registry failure. Never let `last_used_at` writes
  become the authorization transaction; coalesce them asynchronously.

## Rate limits and audit

- Keep pre-auth global/concurrency limits, then rate-limit by credential ID,
  separately from the resource principal. One owner with several keys needs
  independent abuse attribution. Add stricter create/rotate/revoke limits.
- Add an edge IP/host/path rate rule as defense in depth. Cloudflare counters
  are per data center, not global; origin limits remain required. Avoid using
  the raw Authorization value as a logged/counting identifier.
  [Cloudflare rate calculation](https://developers.cloudflare.com/waf/rate-limiting-rules/request-rate/)
- Audit create, reveal completion, rotate, revoke request/result, expiry,
  reconciliation, successful use (coalesced), rejected revoked/expired use,
  and authorization failures. Record human principal, credential ID, action,
  timestamps, result, and sanitized Cloudflare/Ray correlation IDs—never
  secret/header/JWT values.
- Correlate local events with Cloudflare Access authentication logs, which
  record successful and failed user/service authentication. Per-request log
  availability depends on plan. [Access authentication logs](https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/access-authentication-logs/)

## MCP standards impact

The current MCP HTTP authorization specification uses OAuth 2.1 bearer access
tokens, Protected Resource Metadata, authorization-server discovery, and
`WWW-Authenticate`; tokens must target the MCP resource and must not be
accepted for other resources. Keep Cloudflare Managed OAuth as the standards
lane. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

The service-token JSON header is a manual non-OAuth compatibility lane. Do not
describe it as MCP OAuth or mint an origin bearer that collides with OAuth.
Continue serving discovery for capable clients and test both lanes at the same
public edge.

## Deployment and test implications

- Add migration-backed credential mapping/lifecycle/audit tables and internal
  runner operations; preserve rollback with the existing state snapshot.
- Add a runner-only Cloudflare API-token file and bounded outbound client
  (fixed account/API host, redirect rejection, time/body bounds).
- Change principal resolution so `cf-service:*` cannot auto-provision. Preserve
  separate `auth actor credential` and `resource owner principal` identities.
- Cloudflare rollout: one-header application setting, Service Auth policy,
  restricted broker API token, expiry alerts, then exact-head deploy/canary.
- Tests: unknown/cross-owner/revoked/expired IDs; forged origin headers; lost
  responses/orphans; leak scans; concurrency; limits; last-used coalescing;
  Dewee live probe; Managed OAuth regression; rollback migration.
- Production proof must separately show edge acceptance, origin mapping,
  immediate local revoke, Cloudflare deletion, direct-origin rejection, and no
  browser/log/DB secret retention.

## Unresolved questions

1. Can Dewee send the exact single-header JSON value, or only `Bearer <token>`?
2. What maximum expiry and rotation overlap does the owner accept?
3. Does the Cloudflare plan provide needed per-request logs/rate characteristics?

## Primary sources
- [Cloudflare service tokens and lifecycle](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Cloudflare service-token API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/)
- [Cloudflare Access JWT validation and claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [MCP HTTP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [OAuth bearer-token security](https://www.rfc-editor.org/rfc/rfc6750.html)
