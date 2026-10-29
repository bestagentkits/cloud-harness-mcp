# ADR 0008: agentkit.best Sign-in, Lockfile Kit Install, and Vault Secret Grants

- **Status:** Accepted for lockfile kit install (shipped behind
  `ENABLE_KIT_LOCK_INSTALL`, off by default). Proposed for agentkit.best
  sign-in, personal kit install, and vault secret injection: they wait on the
  AgentKit Identity wave and the shared device relay.
- **Date:** 2026-10-29
- **Related Issues:** bestagentkits/agentkit#2848 (ecosystem linking epic).
  Keeps the single-owner trust model of
  [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md) and the inbound
  OAuth boundary of [ADR 0002](0002-inbound-oauth-grant-provider.md).

## Context

AgentKit links its products through agentkit.best, which already runs an OAuth
2.1 authorization server: discovery at
`https://agentkit.best/.well-known/oauth-authorization-server`, ES256 `at+jwt`
access tokens whose `aud` is exactly one registered resource, keys at
`/.well-known/jwks.json`, Connected Apps revocation, and an RFC 8693 token
exchange that today serves only the Build with AK worker. Every grant belongs
to exactly one resource, and each resource carries its own scopes, token
lifetime, grant lifetime, and eligibility rule.

The ecosystem goal for Cloud Harness is that a user signs in with
agentkit.best, and `workspace_open` installs that user's kit and personal kit
from a lockfile and injects their secrets from AK Vault by grant. Cloud Harness
must keep working with no agentkit.best account at all.

What exists today:

- Inbound auth has three lanes: the `owner-bearer` token, Managed OAuth through
  Cloudflare Access (identity is the Access-normalized `(issuer, subject)`),
  and the principal-bound API-key gateway
  ([security model](../security-model.md#public-authentication-and-request-controls)).
- The `agentkit` toolkit kind resolves a signed kit package from the
  agentkit.best registry with a licence token the operator stores as a
  provisioning-purpose secret
  ([configuration](../configuration.md#licensed-agentkit-kits)). The registry
  verifies entitlement; the runner verifies the Ed25519 manifest signature and
  the package SHA-256.
- Workspace secrets come from the runner-held keyring and are injected as
  executor environment with stream redaction.

AgentKit records installed skills in `agentkit.skill-lock/v1`; SkillX records a
personal kit revision in `skillx.personal-kit-lock/v1`. AK Vault is
zero-knowledge: the server stores only ciphertext, a vault key decrypts every
item in its vault, and release decisions are device-local grants intersected
with a portable policy.

## Decision

### 1. agentkit.best as an additional sign-in lane

agentkit.best becomes a fourth inbound lane. The other three are unchanged, and
an instance that does not configure it behaves exactly as before.

- **Route.** The lane serves MCP on a hostname that the Cloudflare Access
  application does not cover, so Access discovery on `/mcp` stays untouched. The
  hostname publishes RFC 9728 protected resource metadata naming
  `https://agentkit.best` as its only authorization server.
- **Token check.** The API verifies the bearer locally against the agentkit.best
  JWKS: `alg` ES256, `typ` `at+jwt`, `iss` `https://agentkit.best`, `aud`
  exactly the configured resource, `exp - iat` no longer than the registered
  access-token lifetime, and `scope` containing `cloud-harness:workspace`. JWKS
  fetching follows the Access verifier's fixed-URL, no-redirect, bounded-cache
  rules.
- **Principal.** Identity is `(https://agentkit.best, sub)`, the same
  issuer-plus-subject model as Access. An operator binds an agentkit.best
  subject to the owner principal explicitly. There is no first-login or
  same-email linking, so signing in with agentkit.best never creates a new
  principal on a single-owner instance.
- **Revocation.** The resource asks for 60-second access tokens with a sliding
  30-day grant. Revoking the grant in Connected Apps stops refresh, so an old
  token fails within 60 seconds without an introspection call.
- **Downstream tokens.** The harness never asks the MCP client for other
  resources. It exchanges the caller's harness token (RFC 8693) for a
  short-lived delegated token for one downstream resource at a time, as the
  confidential client `cloud-harness`. The exchange runs in the runner, which
  already holds every outbound credential; the API forwards only the verified
  subject.

### 2. Kit install from a lockfile

`workspace_open` accepts `kitLocks`, at most two lock documents, beside
`toolkits`. This part needs no agentkit.best change and ships now, behind
`ENABLE_KIT_LOCK_INSTALL`.

- An `agentkit.skill-lock/v1` lock expands into one pinned `agentkit` toolkit
  selection per kit (`engineer`, `marketing`). The selection uses the locked
  `kitVersion`, the channel its prerelease tag names, and an include filter of
  the locked aliases. The registry signature and package digest stay the
  integrity root, and the existing credential and cache rules apply unchanged.
- A lock is installed whole or refused. An entry with no engineer or marketing
  kit source (SkillX, Git, local, or another kit), two versions of one kit,
  an unpinned version, or a kit also chosen in `toolkits` fails with
  `INVALID_INPUT` before anything is fetched. After resolution, every locked
  package must appear in its kit bundle, or the open fails with `NOT_FOUND`
  naming the missing skills.
- Lock-derived selections join `toolkits` before the request fingerprint is
  computed, so an idempotent replay with a different lock is a conflict.
- Per-skill `treeDigest` values are not re-derived yet. That needs AgentKit's
  canonical tree serialization and archive modes, which the extraction step
  does not preserve today. Until then the lock chooses versions and skills, and
  the signed manifest proves the content.

Executable owners:
[`packages/contracts/src/kit-lock.ts`](../../packages/contracts/src/kit-lock.ts),
[`apps/runner/src/kit-lock-planner.ts`](../../apps/runner/src/kit-lock-planner.ts),
and its tests.

Once a caller signs in with agentkit.best, the runner obtains the registry
credential by token exchange instead of the stored licence secret. A caller
without a linked account keeps the stored provisioning secret, so standalone
installs are unchanged.

### 3. Personal kit install

A `skillx.personal-kit-lock/v1` lock is validated today and refused with an
explicit message. After sign-in exists, the runner exchanges for a SkillX
delegated token and, for each entry, resolves the release pinned by
`releaseDigest`, verifies the signed `skillx.release/v2` manifest, applies the
`agentkit.skill-overlay/v1` operations, and checks `compositionDigest`, then
`revisionDigest` for the whole kit. The result mounts as one owner-scoped,
read-only toolkit. A private kit never goes into a repository checkout.

### 4. Secrets by vault grant

Two delivery shapes were compared. Both keep the vault server and relay
zero-knowledge: they carry only ciphertext. The harness becomes a plaintext
recipient only through the owner's explicit grant, like any of the owner's
devices.

| | Relay (default) | Machine device (opt-in) |
| --- | --- | --- |
| Who decrypts | The owner's online device, then seals each value to a key that exists only for this workspace open | The harness, enrolled as a read-only `machine` device of a dedicated vault |
| Standing key on the harness | None | The dedicated vault's key, in the runner keyring |
| Needs a device online | Yes, at open and recovery | No |
| Least privilege | Per secret, by the device-local grant | Per vault: use a vault that holds only what workspaces need |
| Revocation | Remove the device-local grant | Remove the machine device and rotate the vault epoch |

The relay is the default because device-local grants stay authoritative, which
is the vault's own invariant, and a runner compromise reveals no vault key. The
machine-device shape is for unattended automations that open workspaces while
no device is online.

Relay flow, as proposed:

1. `workspace_open` names the secrets (`vaultGrants`: secret names and a
   purpose; a future contract change).
2. The runner creates a one-time X25519 key pair for this open and sends a
   release request through the shared device relay with a delegated
   `ak-vault:relay` token. The request carries the instance, workspace, names,
   purpose, public key, and a deadline.
3. The owner's device evaluates the device-local grant intersected with the
   portable policy, asks for approval when a value is `sensitivity: "high"`,
   and seals each released value to the one-time key.
4. The runner opens the sealed box, injects the values as executor environment
   for that workspace only, and registers them with the stream redactor. It
   persists names and versions, never plaintext or the one-time private key.
   Recovery asks again.
5. If no device answers before the deadline, the open fails with a retryable
   error. Missing secrets are never a silent downgrade.

Scope of the guarantee: values go only into workspaces of the principal whose
linked agentkit.best subject owns the vault. Repository code in that workspace
can read them, exactly like runtime secrets today. This is a per-user
convenience inside the single-owner model, not a hostile multi-tenant control.

## Registration needed from agentkit.best

The Identity wave registers these in `lib/oauth/protocol.ts` of
bestagentkits/ak-web. The first-party instance uses the resource below;
self-hosted instances keep their own auth until per-instance resources exist.

- **Resource** `https://harness.agentkit.best/mcp`, label "Cloud Harness":
  scope `cloud-harness:workspace`, `defaultScopes` that same scope, access
  token 60 seconds, grant 30 days sliding, eligibility `customer`. Consent copy
  must say the scope can open workspaces and run code in them for the account.
- **Confidential client** `cloud-harness`, allowed to use the token exchange
  with a harness-resource subject token, for these targets only, each issued
  for 60 seconds with `act.sub` `cloud-harness`:
  - the kit registry resource (`https://agentkit.best/api/agentkit`, scope
    `agentkit-kits:read`), accepted by
    `GET /api/agentkit/kits/{kitId}/resolve` in place of a licence token;
  - the SkillX resource from the Identity wave, scope `skillx-kits:read`, for
    personal kit revisions and releases;
  - the AK Vault relay resource, scope `ak-vault:relay`, for release requests.

## Rejected alternatives

- **Replacing Cloudflare Access with agentkit.best.** That would make an
  agentkit.best account mandatory and change the live auth lane.
- **One grant spanning several resources.** agentkit.best binds a grant to one
  resource by design; token exchange keeps that model.
- **Linking accounts by email.** Email is metadata in every lane; identity is
  issuer plus subject.
- **Installing the installable part of a lock.** A partial install leaves the
  workspace silently different from the machine that wrote the lock.
- **Storing vault plaintext in the harness keyring for reuse.** It would turn a
  per-open release into a standing copy outside the vault's revocation.

## Consequences

- Lockfile install is available now as an operator opt-in and covers
  kit-owned skills only.
- The sign-in lane, personal kit install, and vault grants each need an
  agentkit.best or relay change first; each lands with its own contract,
  security-model, and docs update.
- The `cloud-harness` client secret and the delegated tokens become runner-only
  control-plane credentials, under the same boundary as the GitHub App key.
