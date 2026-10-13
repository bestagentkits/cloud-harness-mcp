# ADR 0002: Inbound MCP OAuth Grant Provider Boundary

- **Status:** Accepted for the Cloudflare Access adapter; a Cloud
  Harness-owned authorization server is deferred.
- **Date:** 2026-10-13
- **Related Issues:** Issue #282

## Context

MCP clients on the Managed OAuth lane sign in through Cloudflare Access. How
long a client stays signed in is the Access application's OAuth grant session
duration, which operators previously changed only in Cloudflare Zero Trust.
Cloudflare bounds that grant, so no setting there can keep a client signed in
indefinitely.

## Decision

Dashboard Settings manages the inbound grant through a provider interface,
[`OAuthGrantProvider`](../../apps/runner/src/oauth-grant-provider.ts), held by
the runner. The provider stays the authority for effective values; Cloud
Harness records only what it applied and the provider confirmed on read-back.
The first adapter,
[`CloudflareAccessOAuthProvider`](../../apps/runner/src/cloudflare-access-oauth-provider.ts),
edits only the grant session duration and access-token lifetime of one
self-hosted Access application. The safety boundary is recorded in the
[security model](../security-model.md#inbound-mcp-oauth-session-lifetimes).

Access tokens stay short in every adapter. Each refresh re-evaluates the
provider's access policy, so a long grant extends sign-in continuity without
delaying revocation beyond the next refresh.

## Rejected and deferred alternatives

- **Unbounded grant through Cloudflare:** not offered by the provider. The
  Dashboard never renders "forever" for a bounded provider.
- **Lengthening the access-token lifetime instead:** reduces policy re-checks
  without reducing sign-ins.
- **Cloud Harness-owned authorization server (deferred):** could offer a grant
  that lasts until revoked, but would make Cloud Harness responsible for
  refresh-token storage, rotation, reuse detection, and revocation, which
  Cloudflare currently owns. The interface reserves `supportsUnboundedGrant`
  for that adapter; adopting it requires its own security review and a new
  decision record.

## Consequences

- A runner-only Cloudflare API token with Access application write authority
  becomes part of the trusted control plane.
- Release rollback restores Cloud Harness state, not the provider value, so a
  rollback can leave the Settings panel reporting a drifted grant.
- Live Cloudflare behaviour is covered by unit tests with a fetch double
  ([`apps/runner/test/cloudflare-access-oauth-provider.test.ts`](../../apps/runner/test/cloudflare-access-oauth-provider.test.ts)),
  not by a verified run against a real account.
