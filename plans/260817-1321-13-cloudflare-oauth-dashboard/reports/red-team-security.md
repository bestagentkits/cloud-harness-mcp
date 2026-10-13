# Red-team security review

Date: 2026-08-17
Lens: hostile security adversary / fact checker
Scope: plan documents only; factual claims checked against repository source, tests, docs, issues, and current official Cloudflare documentation. No tests, builds, or code changes run.

## Findings

### 1. Critical — multi-principal Access admission violates the executor threat model

- **Plan location:** `plan.md:20,27,42-47`; `phase-01-principal-authentication-and-authorization-core.md:41-50`.
- **Failure scenario:** Access admits two different users. Principal B opens a malicious repository or invokes the existing `exec_run`/shell/task surface. A container escape or runner/Docker compromise crosses the shared kernel and exposes principal A's workspace and control plane. Principal-qualified SQLite rows do not mitigate this. The plan acknowledges that principal isolation is not hostile multi-tenancy, but still defines multiple independently admitted principals with full workspace execution and no trust/admission restriction.
- **Evidence:** the repository explicitly says these tools are intentional remote code execution and bearer authentication does not make repositories trustworthy (`docs/security-model.md:5-12`). It further states that a runner compromise controls the host, a container escape crosses the boundary, and mutually distrustful tenants require separate execution hosts or VM/microVM isolation (`docs/security-model.md:41-45`). The current MCP tool contract exposes exec, shells, sessions, tasks, hooks, skills, and deployments (`packages/contracts/src/runner-api.ts:4-16`).
- **Suggested fix:** make the release contract explicit: Access policy may admit only one owner or a named set of mutually trusted operators sharing one security domain. If #13 truly means mutually distrustful principals, block delivery on per-principal execution hosts/VM-grade isolation and quota-backed storage. Add a test/config guard for the selected admission model; do not present row-level authorization as tenant isolation.

### 2. High — Managed OAuth token handling is ambiguous at the exact authentication seam

- **Plan location:** `plan.md:20,42`; `phase-01-principal-authentication-and-authorization-core.md:18-21,27,38-42`; `phase-04-deployment-verification-and-rollout.md:19-20,36`.
- **Failure scenario:** implementation extends today's `Authorization: Bearer` parser and attempts to validate the Managed OAuth access token as a JWT, or trusts a caller-supplied assertion-like header without a clearly defined extraction/overwrite boundary. Cloudflare Managed OAuth gives the client an opaque token; Cloudflare resolves it and forwards the signed identity JWT to the origin in `Cf-Access-Jwt-Assertion`. The origin either rejects every valid client or authenticates the wrong credential surface. Separately, the current MCP callback has no principal parameter and calls a globally configured owner, so a careless implementation can fall back to global/request-crossing identity state.
- **Evidence:** current auth reads `Authorization`, stores the raw bearer in `request.auth`, and assigns configured `OWNER_ID` (`apps/api/src/auth.ts:14-24`). MCP callbacks call `RunnerClient` without request identity (`apps/api/src/mcp-server.ts:13-34`), and the client hard-codes configured owner identity into the runner request (`apps/api/src/runner-client.ts:6-14`). Cloudflare documents that Managed OAuth access tokens are opaque and that the MCP origin must validate the JWT forwarded in `Cf-Access-Jwt-Assertion`: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) and [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
- **Suggested fix:** specify and test one exact contract: in Access mode, ignore the opaque `Authorization` value for identity, read only Cloudflare's forwarded `Cf-Access-Jwt-Assertion`, verify it cryptographically, and attach a normalized principal through an explicitly request-local SDK/handler seam. Add tests proving an opaque OAuth bearer alone is not parsed as JWT, a forged assertion fails, client input cannot override principal, and concurrent requests cannot exchange principals. If the MCP SDK cannot expose request auth safely, make handler-seam redesign a prerequisite rather than a runtime fallback.

### 3. High — unknown-`kid` traffic can turn JWKS rotation into unauthenticated outbound DoS

- **Plan location:** `phase-01-principal-authentication-and-authorization-core.md:19,22,39,42,54`.
- **Failure scenario:** an attacker reaches the public origin and sends many syntactically valid JWTs with unique `kid` values. A naive “refetch on unknown key” implementation performs one outbound JWKS request per attempt before a principal exists. The proposed per-principal rate limiter cannot apply, exhausting API concurrency, Cloudflare/JWKS availability, sockets, or egress. A JWKS outage then denies all users.
- **Evidence:** current middleware authenticates before applying request limits (`apps/api/src/app.ts:23-24`), while the limit itself is only a process-local global counter (`apps/api/src/request-security.ts:32-55`). The plan asks for bounded caching and per-principal limits but does not require pre-auth throttling, unknown-key negative caching, refresh cooldown, or single-flight refresh. The public security model confirms current limits are process-local rather than distributed protection (`docs/security-model.md:47-61`).
- **Suggested fix:** retain a global unauthenticated request/concurrency cap before JWT verification, then layer bounded per-principal limits after authentication. Require single-flight JWKS refresh, refresh cooldown, bounded positive and negative `kid` caches, response size/time limits, and use of a valid cached key until its explicit bounded stale window expires. Test a flood of distinct unknown `kid` values and assert bounded JWKS fetch count and bounded memory.

### 4. High — legacy owner migration can become first-login takeover or lockout

- **Plan location:** `phase-01-principal-authentication-and-authorization-core.md:20,23,40,42,54`; `phase-04-deployment-verification-and-rollout.md:47`.
- **Failure scenario:** enabling Access creates opaque principals keyed by `(issuer, subject)`, but existing rows are owned by the arbitrary configured string `OWNER_ID`. If “legacy owner mapping” is assigned to the first successful Access login, the first admitted account claims every existing workspace. If no deterministic mapping exists, the real owner loses access. Switching back to `owner-bearer` can likewise orphan Access-created rows or accidentally collapse several principals into one owner.
- **Evidence:** today's API has one configured `OWNER_ID` (`packages/contracts/src/config.ts:5-15`) and always sends it to the runner (`apps/api/src/runner-client.ts:10-14`). SQLite stores it directly as `workspaces.owner_id`, with idempotency and active-workspace uniqueness scoped to that value (`apps/runner/src/state-store.ts:43-57,70-88`). The operator baseline hard-codes `OWNER_ID=owner` (`deploy/scripts/bootstrap-vps.sh:15-29`).
- **Suggested fix:** define a deterministic, operator-approved migration before code changes: exact legacy owner ID, exact Access issuer/subject allowed to claim it, transactional dry-run/counts, abort on mismatch, and backup/restore procedure. Never bind legacy data on first login or by email. Define rollback semantics separately: whether Access-created principals remain inaccessible in bearer mode or map through an explicit reversible table; prove both directions in migration and restart tests.

### 5. High — per-principal GitHub authorization is only metadata over one global installation

- **Plan location:** `plan.md:25,59`; `phase-03-environment-secret-github-artifact-audit.md:14,21,31,41,43,48-50`.
- **Failure scenario:** dashboard user A submits or selects an installation/repository association belonging to B, or all principals unknowingly share the one globally configured installation. The runner then mints a token for the global installation and reports “authorized” metadata without a principal-bound connect/callback proof. This fails issue #18's requirement to connect and manage GitHub repository authorization and can grant repository access based on attacker-controlled metadata.
- **Evidence:** runner configuration supports exactly one global `GITHUB_APP_INSTALLATION_ID` (`packages/contracts/src/config.ts:33-37`; `apps/runner/src/config.ts:12-35`). Token minting uses that global installation and only supplies the repository name, with no principal, installation ownership record, callback state, or repository-owner binding (`apps/runner/src/github-app-broker.ts:4-18`). Configuration docs likewise describe one installation shared by all clone/fetch/pull/push operations (`docs/configuration.md:65-85`).
- **Suggested fix:** plan the real authorization protocol, not only tables/status: principal-bound one-time signed state and expiry for GitHub App installation callbacks, installation-account verification, repository owner/name verification against GitHub's installation API, explicit connect/disconnect/revoke behavior, and runner-side selection by authenticated principal. Never accept a browser-supplied installation ID as authority. If the initial release retains one operator-managed installation, say so and do not claim per-principal GitHub connection/management or closure of that #18 scope.

## Unresolved questions

- Is Access admission restricted to mutually trusted operators, or are mutually distrustful users intended?
- Which exact Access issuer/subject is authorized to inherit current `OWNER_ID=owner` data?
- Is GitHub authorization one operator-managed installation or a true per-principal installation flow?

**Status:** DONE
**Summary:** Five Critical/High plan flaws found: executor threat-model mismatch, ambiguous Managed OAuth credential seam, JWKS refresh DoS, unsafe legacy ownership migration, and incomplete GitHub authorization binding.
**Concerns/Blockers:** The plan should not proceed to implementation until findings 1, 2, 4, and 5 have explicit accepted security contracts.
