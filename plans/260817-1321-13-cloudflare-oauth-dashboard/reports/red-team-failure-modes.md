# Hostile failure-mode review: Cloudflare OAuth dashboard plan

Scope: plan documents only, checked against current source, tests, and repository docs. No code quality pass and no test/build execution.

## Findings

### 1. Critical — dashboard-only runner operations will become public MCP tools

- **Plan location:** `phase-03-environment-secret-github-artifact-audit.md:24-32` says metadata operations are dashboard-only, but directs implementation into `packages/contracts/src/runner-api.ts`.
- **Failure scenario:** Adding project, secret, GitHub-installation, artifact, or audit operations to `RunnerOperationSchema` makes them part of the public MCP inventory. `tool-schemas.ts` requires a schema for every runner operation and generates `TOOL_SPECS` from all of them; the MCP server then registers every spec. A supposedly dashboard-only secret rotate/delete operation therefore either appears as an MCP tool or breaks the contract/build when deliberately omitted.
- **Evidence:** `packages/contracts/src/runner-api.ts:4-17`; `packages/contracts/src/tool-schemas.ts:23-24`; `packages/contracts/src/tool-schemas.ts:94-97`; `packages/contracts/src/tool-schemas.ts:125-136`; `apps/api/src/mcp-server.ts:18-34`; `packages/contracts/test/cloudharness-skill-contract.test.ts:25-34`; `docs/mcp-api.md:11-18`.
- **Fix:** Split `PublicMcpOperationSchema` from a versioned internal `RunnerOperationSchema`. Generate `TOOL_SPECS` only from the public schema. Add a contract test proving internal dashboard operations are accepted by API-to-runner RPC but absent from MCP `tools/list`, the canonical skill inventory, and public docs.

### 2. High — Access mode cannot pass the current deployment smoke/canary

- **Plan location:** `plan.md:24-28`, `phase-04-deployment-verification-and-rollout.md:29-36`, and `phase-04-deployment-verification-and-rollout.md:45-47` require mutually exclusive auth modes and an Access-mode canary/rollout, but never make the deployment verifier auth-mode-aware.
- **Failure scenario:** An operator configures `cloudflare-access`. The deploy script starts the new service, then posts a static `MCP_BEARER_TOKEN` directly to loopback and runs a canary that requires the same token. Because Access mode must reject owner-bearer authentication, both checks fail and the deploy automatically rolls back before the documented Access login/discovery checks can occur. Allowing the bearer just for the canary would violate the mutual-exclusion requirement and test a bypass path, not production auth.
- **Evidence:** `deploy/scripts/deploy-release.sh:42-70`; `deploy/scripts/deploy-release.sh:81-96`; `scripts/deploy-canary.mjs:3-5`; `scripts/deploy-canary.mjs:16-30`; `apps/api/src/app.ts:23-31`.
- **Fix:** Make deploy verification explicitly discriminated by auth mode. Keep `/readyz` as the credential-free internal readiness check. In owner-bearer mode run the current tool canary. In Access mode require a separate owner-authorized public-edge OAuth receipt/token and verify discovery, audience, login, one bounded MCP call, and revocation through the actual Access hostname. Never enable a hidden second bearer path.

### 3. High — the rollback claim is incompatible with a versioned SQLite migration and can lose post-cutover state

- **Plan location:** `phase-01-principal-authentication-and-authorization-core.md:23`, `phase-01-principal-authentication-and-authorization-core.md:52-54`, `phase-03-environment-secret-github-artifact-audit.md:18-22`, and `phase-04-deployment-verification-and-rollout.md:45-47` promise transactional migration, backward-readable rollback, retained ciphertext, and runner-state preservation without defining a compatibility window.
- **Failure scenario:** The new runner migrates schema v1 to vNext and starts accepting workspaces, metadata, audit events, or secret writes. The old release cannot reopen that database because it accepts only version 1. The current deployment rollback therefore restores the pre-deploy database copy; every write accepted after cutover disappears, while job directories/containers may have advanced independently. A config-only fallback to `owner-bearer` does not solve a binary rollback or broken migration.
- **Evidence:** `apps/runner/src/state-store.ts:42-61`; `deploy/scripts/deploy-release.sh:47-55`; `deploy/scripts/deploy-release.sh:72-82`; `docs/operations.md:44-49`; `docs/operations.md:66-70`; `docs/operations.md:107-125`.
- **Fix:** Add an explicit expand/contract migration and rollback matrix. Either keep the prior binary forward-readable for the entire rollback window or quiesce external writes until migration and auth canaries pass. Define what happens to post-migration rows/ciphertext on rollback, reconcile jobs/containers with the restored DB, and test failed migration, failed post-start canary, rollback-after-write, and restore from both schema versions.

### 4. High — unknown-`kid` traffic can turn JWKS failure/rotation into an unauthenticated outage

- **Plan location:** `phase-01-principal-authentication-and-authorization-core.md:18-22`, `phase-01-principal-authentication-and-authorization-core.md:38-42`, and `phase-01-principal-authentication-and-authorization-core.md:52-54` require unknown-key refresh, a bounded JWKS cache, and per-principal limiting, but omit unauthenticated fetch controls.
- **Failure scenario:** An attacker sends syntactically valid JWTs with continuously changing `kid` values. Authentication runs before the current request limiter and before a principal exists. A naive “refetch on unknown key” implementation performs concurrent outbound JWKS requests for every token. During Cloudflare slowness or a real rotation, the API exhausts sockets/event-loop capacity and denies valid cached-key requests even though the plan nominally has per-principal rate limits.
- **Evidence:** `apps/api/src/app.ts:23-24`; `apps/api/src/request-security.ts:32-56`; `apps/api/src/auth.ts:14-24`; `docs/security-model.md:47-61`.
- **Fix:** Specify a small global/pre-auth request and concurrency bound, single-flight JWKS refresh, bounded negative-`kid` cache, exponential backoff/jitter, fetch deadline, maximum cache age, and “serve valid cached key while refresh fails” semantics. Test parallel unknown kids, refresh failure, stale-key expiry, recovery, and valid-token latency during the attack.

### 5. High — per-principal GitHub installation binding is not authenticated

- **Plan location:** `phase-03-environment-secret-github-artifact-audit.md:18-22` and `phase-03-environment-secret-github-artifact-audit.md:38-43` require per-principal installation/repository authorization, but specify only status separation and token absence—not an installation connect/callback trust protocol.
- **Failure scenario:** The current broker has one operator-configured installation ID and mints against it. Extending metadata so a browser can submit an installation ID lets principal A bind B's installation unless the service proves the callback state, installation ownership, App identity, and repository grant at GitHub. Keeping the global ID instead makes every principal share the owner's repository authority, contradicting per-principal authorization.
- **Evidence:** `packages/contracts/src/config.ts:33-37`; `apps/runner/src/config.ts:12-35`; `apps/runner/src/github-app-broker.ts:4-18`; `docs/configuration.md:65-85`.
- **Fix:** Add a server-generated, expiring, single-use state/nonce tied to the authenticated principal; validate the GitHub App setup callback and query the installation/repository grant server-side before binding. Never trust browser-supplied installation ownership. Define uninstall/suspension/repository-removal refresh behavior and test callback replay, cross-principal swap, wrong App, revoked installation, and repository removal.

## Unresolved questions

1. Must rollback preserve writes accepted after schema migration, or may rollout quiesce all mutating traffic until promotion?
2. Is per-principal GitHub App installation management truly in scope, including setup callback and revocation, or should #18 retain only operator-configured global installation status?

**Status:** DONE
**Summary:** Five contract-level failure modes found: one Critical and four High. Primary blockers are internal/public operation separation, auth-mode-aware deployment verification, schema-safe rollback, bounded JWKS failure behavior, and authenticated GitHub installation binding.
**Concerns/Blockers:** Plan should not proceed to implementation until all five findings have explicit contract and rollback decisions.
