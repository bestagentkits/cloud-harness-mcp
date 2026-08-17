# Cloudflare SSO and OAuth architecture

Date: 2026-08-17

## Recommendation

Use **Cloudflare Access as the identity and OAuth edge**, not a custom OAuth
server in the first implementation.

- Host the dashboard/BFF on Workers (or Pages Functions) behind a self-hosted
  Access application. Configure both Google and GitHub login methods and one
  explicit allow policy.
- Put the MCP hostname behind an Access **MCP server application with Managed
  OAuth**. Managed OAuth turns Access into a standard OAuth 2.0 authorization
  server, requires RFC 8707-aware clients, exposes OAuth discovery conforming
  to RFC 8414/RFC 9728, issues opaque client tokens, and forwards a signed
  `Cf-Access-Jwt-Assertion` to the origin after resolving the user.
- The API must validate that Access assertion and map `(iss, sub)` to an
  internal principal before any resource lookup. Access is authentication and
  coarse application admission; workspace/repository/task/artifact ownership
  remains Cloud Harness authorization.
- Keep repository access separate from login. GitHub SSO is identity only;
  the existing runner-confined GitHub App remains the repository authorization
  and token broker.

This is the smallest Cloudflare-native design that supports the browser and
standards-based MCP clients with one normalized identity boundary.

## Does Access alone satisfy issue #13?

**Client authentication: yes, if Managed OAuth is enabled. Full issue #13: no.**

Ordinary Access cookie protection alone redirects non-browser clients and is
not sufficient. [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
adds the authorization-code flow and standards discovery; the client receives
an opaque access token and the origin receives a signed Access JWT. This covers
the standards-based client-authentication portion and issuer/key rotation.

Access does not bind Cloud Harness records to principals or enforce ownership.
The application must still:

- create a durable internal principal keyed by Access issuer plus subject;
- bind every workspace, repository, task, session, artifact, and audit record;
- authorize before existence-revealing lookup and return indistinguishable
  denial responses;
- test guessed/replayed handles across principals.

Access documents `sub` as unique to an email address within an account, but it
changes if the user is removed and re-added. Treat email as display data, not
the application key. See [Access application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

## Auth modes and backward compatibility

Make authentication an explicit deployment mode, defaulting to today's model:

| Mode | `/mcp` authentication | Principal behavior |
| --- | --- | --- |
| `owner-bearer` (default) | Existing static bearer | Fixed `OWNER_ID`; no Access/OAuth config required |
| `cloudflare-access` (opt-in) | Access Managed OAuth / Access assertion | Internal principal resolved from `(iss, sub)` |

Do not silently accept both token families at the same endpoint. If migration
requires temporary coexistence, use separate hostnames/Access applications and
audiences. In bearer mode, an optional dashboard BFF may hold the owner bearer
server-side, but the browser must never receive it and Access policy must allow
only the owner.

## JWT, rotation, and identity checks

At every Access-protected origin/BFF request:

1. Read `Cf-Access-Jwt-Assertion` (Cloudflare recommends it over the cookie).
2. Verify the signature using the team JWKS endpoint
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
3. Require expected `iss`, application `aud`, `exp`, `nbf`, `type=app`, and a
   non-empty `sub`; restrict the accepted algorithm to RS256.
4. Cache by `kid`, refetch on an unknown key, and never hard-code
   `public_cert`. Access rotates keys every six weeks by default and retains the
   previous key for seven days.

Official implementation guidance: [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

For Managed OAuth, prefer the documented 5–15 minute access-token lifetime and
1–2 week grant session only if that operational window is acceptable; Access
re-evaluates policy on refresh. Per-user and per-application revocation are
available through Access session management.

## Browser session and CSRF boundary

Access owns its login cookies and includes per-team/per-application CSRF
cookies, but that does not remove application-level CSRF protection for BFF
mutations.

- Keep dashboard APIs same-origin; enforce exact Host and Origin.
- Use a server-side opaque dashboard session or request-bound CSRF state. Set
  application cookies `Secure`, `HttpOnly`, and `SameSite=Lax`; rotate session
  identifiers after authentication and privilege changes.
- Require a per-session CSRF token in a custom header for every mutation and
  reject form/simple cross-origin mutation requests.
- Keep all OAuth state, provider credentials, Access assertions, owner bearer,
  GitHub App credentials, and raw secret values out of browser storage.
- Consider Access Binding Cookie for the browser dashboard if One Client,
  Zaraz, or Google tag gateway compatibility does not rule it out.

Access cookie behavior and caveats are documented in [Authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/).

## GitHub and Google SSO

Cloudflare Access supports both login methods:

- [GitHub login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/)
  uses a GitHub OAuth App callback at the Access team domain. Access requests
  read-only organization/team and email permissions.
- [Google login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/)
  supports ordinary Google accounts without Google Workspace; Access also
  offers PKCE for that integration.

Use Access's normalized subject at the application boundary. If a future design
bypasses Access, Google requires server-side ID-token signature/issuer/audience/
expiry validation and says to key users by `sub`, not email; GitHub direct OAuth
requires CSRF `state` and a server-side identity lookup. Primary references:
[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)
and [GitHub OAuth guidance](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app).

## When to use Workers OAuth Provider instead

Adopt [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
only if Managed OAuth fails a required client or product capability. It offers
explicit RFC 9728 protected-resource metadata, RFC 8414 metadata, RFC 8707
audience binding, PKCE, refresh rotation/revocation, CIMD, DCR fallback, custom
consent, and scopes. It is the better choice when Cloud Harness needs granular
tool scopes or product-owned consent.

The cost is material: Cloud Harness must own the authorization UI, upstream
Access/Google/GitHub authentication handler, session/CSRF behavior, OAuth KV
state, and the trusted principal propagation boundary to the existing API.
Cloudflare explicitly notes that the library is not itself an identity
provider. Current MCP authorization also prefers CIMD while retaining DCR for
compatibility; see the [MCP authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization).

## Decision table

| Option | Dashboard SSO | Generic MCP OAuth | App scopes/consent | Recommendation |
| --- | --- | --- | --- | --- |
| Access cookie only | Yes | No | Access policy only | Dashboard only |
| Access + Managed OAuth | Yes | Yes, RFC 8707 client required | Coarse Access policy | **Start here** |
| Workers OAuth Provider + upstream IdP | Yes, custom | Yes, fullest control | Custom scopes/consent | Escalation path |

## Validation required before ship

- Confirm the production hostname is on a Cloudflare-managed zone in the same
  account as the Zero Trust organization; the current `sslip.io` hostname may
  not meet that prerequisite.
- Test discovery, login, refresh, logout/revocation, and resource audience with
  each target MCP client (at minimum ChatGPT, Claude, Codex, and Cursor).
- Prove Google and GitHub logins map to the intended Access subject behavior;
  do not auto-link different emails.
- Run cross-principal authorization tests at every opaque-handle boundary.
- Verify dashboard mutations against cross-site requests and confirm neither
  browser responses nor logs expose control-plane/provider secrets.

## Unresolved questions

- Is there an owned Cloudflare zone and Zero Trust account available for the
  production MCP/dashboard hostnames?
- Must the initial release support granular OAuth scopes/consent, or is one
  Access application policy sufficient?
- Which MCP client versions are release-gating? Managed OAuth documents DCR
  configuration, while MCP 2026 prefers CIMD; compatibility needs live proof.
- Should Google and GitHub accounts sharing an email intentionally represent
  one principal, or require explicit account linking?

## Research note

The `ak:docs-seeker` Context7 fetch returned `Documentation not found`; research
therefore used only current official Cloudflare, GitHub, Google, MCP, and IETF-
linked primary documentation.
