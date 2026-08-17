# Phase 3 post-implementation advice

Date: 2026-08-17

## Decision

**NO-GO for declaring Phase 3 complete, entering the Phase 4 ship gate, or closing #18.**

The implementation establishes a credible core: Access assertions are verified at the API, request-local `(issuer, subject)` identity reaches the runner, resource lookups are principal-qualified, dashboard responses are allowlisted, secrets use AEAD, and GitHub repository tokens remain runner-confined. Focused and repository-wide tests are green. However, several accepted Phase 3 contracts are incomplete or contradicted by concrete runtime paths. Phase 4 may be prepared, but deployment work must not be used to mark these application defects complete.

Issue #18 cannot honestly close from this branch. GitHub installation management, retained artifact lifecycle, deletion semantics, degraded secret readiness, mutation audit coverage, and operational persistence remain incomplete. Issue #13 also retains an accepted subject-change recovery requirement and still lacks live Access/IdP evidence, which the plan correctly reserves for Phase 4/operator rollout.

## Verified boundaries to preserve

- Cloudflare Access identity comes only from a verified `Cf-Access-Jwt-Assertion`; the opaque MCP bearer is not interpreted as identity (`apps/api/src/auth.ts:73-116`, `apps/api/src/access-jwt-verifier.ts:91-125`). Issuer, audience, `type=app`, RS256, subject, time claims, and JWKS bounds are enforced.
- Email/name are display metadata. Persistence and authorization key on `(issuer, subject)` (`apps/runner/src/principal-store.ts:57-67`, `apps/runner/src/principal-store.ts:76-82`). This matches the accepted Access-normalized identity decision and permits Cloudflare's same-email GitHub/Google convergence without trusting email inside Cloud Harness.
- GitHub SSO does not imply repository access. Repository authorization uses a separate principal-bound GitHub App installation/grant store; token minting checks the authenticated principal's verified grant (`apps/runner/src/workspace-service.ts:541-549`, `apps/runner/src/github-app-broker.ts`).
- Public MCP operations remain separate from internal dashboard operations (`packages/contracts/src/internal-runner-api.ts:6-31`, `packages/contracts/src/internal-runner-api.ts:40-90`). BFF mappings do not return submitted secrets, provider credentials, runner tokens, or artifact paths.
- Secret ciphertext uses AES-256-GCM with associated data bound to principal/environment/name/version (`apps/runner/src/secret-keyring.ts:22-28`, `apps/runner/src/secret-keyring.ts:92-107`). Environment injection requires explicit selection/confirmation and rejects control/provider credential names (`packages/contracts/src/tool-schemas.ts:24-33`, `apps/runner/src/workspace-environment.ts:3-18`).

## Mandatory before Phase 3 completion

### P0 — Complete Access subject-change recovery

The accepted plan says same-email IdP identities may converge and changed Access subjects require an audited operator relink. Current code resolves or creates only the exact `(issuer, subject)` row and has no relink operation (`apps/runner/src/principal-store.ts:91-133`). Legacy bootstrap mapping is not general subject-rotation recovery (`apps/runner/src/principal-store.ts:136-153`).

Add an operator-authorized old-principal-to-new-subject relink with collision checks, quiescing, transactional ownership preservation, and redacted audit evidence. Never relink by email or first login. Test subject change, target collision, replay, rollback, and preserved workspace/project/GitHub ownership. Until then #13's accepted durable identity behavior is incomplete.

### P0 — Make per-principal GitHub setup usable and fail closed

A fresh Access deployment cannot enable the installation ceremony without already configuring a legacy installation ID. `githubApp.installationId` is required by schema, and the whole GitHub config is omitted unless `GITHUB_APP_INSTALLATION_ID` exists (`packages/contracts/src/config.ts:69-74`, `apps/runner/src/config.ts:13-15`, `apps/runner/src/config.ts:48-53`). Partial GitHub config silently disables the feature.

Split App identity credentials (`appId`, private key, slug) from the optional owner-bearer/default installation. Require the default ID only for the legacy bearer path; reject partial configuration at startup. Test first Access-mode installation with no prior installation.

Provider uninstall is stale locally: GitHub 404 becomes `NOT_FOUND`, while reconciliation persists only after successful verification (`apps/runner/src/github-api-installation-verifier.ts:45-53`, `apps/runner/src/github-binding-service.ts:91-103`). Add a principal-scoped transaction that marks uninstalled, removes grants, advances generations/check timestamps, and audits. Test the real 404 path through status, restart, and token-mint denial.

### P0 — Fulfil "every mutation is auditable"

Artifact and GitHub mutations commit first and append audit afterward in a separate transaction (`apps/runner/src/artifact-store.ts:65-95`, `apps/runner/src/artifact-store.ts:125-153`, `apps/runner/src/github-installation-sqlite-store.ts:54-91`, `apps/runner/src/dashboard-control-service.ts:50-76`). Audit failure can leave a successful mutation with an error response and no event.

Make artifact/GitHub state plus audit atomic through the owning transaction or a durable outbox. Add fault-injection tests proving both commit or neither. Also cover dashboard file mutations and generation-fenced workspace close: current audit call sites contain no file/workspace events, so #18's acceptance criterion is unmet. For filesystem mutations, define and test a durable intent/outcome model rather than silently omitting audit.

### P0 — Define and enforce aggregate deletion

Lists return deleted projects/environments, deletes do not transition descendants, and secret rotate/delete does not require an active parent (`apps/runner/src/metadata-store.ts:48-50`, `apps/runner/src/metadata-store.ts:81-97`, `apps/runner/src/secret-metadata-store.ts:37-40`, `apps/runner/src/secret-metadata-store.ts:73-105`). A deleted project's active environment can still inject secrets because lookup checks only environment state (`apps/runner/src/metadata-store.ts:100-104`). Tombstoned names cannot be recreated due unconditional unique constraints (`apps/runner/src/metadata-schema.ts:29-30`, `apps/runner/src/metadata-schema.ts:44-45`, `apps/runner/src/metadata-schema.ts:61-63`). This contradicts the UI's delete wording.

Choose one contract: reject parent deletion while active descendants exist, or transactionally cascade soft deletion with audit. Filter ordinary list/mutation/injection paths to active aggregates and define tombstone/history access separately. Test aggregate deletion, injection denial, and same-name recreation.

### P0 — Make secret degraded readiness real

With no keyring, `secret_list` dereferences the throwing `metadata.secrets` getter before returning readiness (`apps/runner/src/dashboard-control-service.ts:36`, `apps/runner/src/metadata-store.ts:28-45`). Malformed or incomplete keyrings can abort runner startup because keyring construction is outside the degradation boundary (`apps/runner/src/index.ts:17-20`).

Separate reference-only listing from decrypt capability, return sanitized `{ready:false}`, and map secret mutation/injection failures to a bounded 503. Align malformed/missing historical-key behavior with the accepted degraded-read contract and test through the actual internal runner endpoint.

### P1 — Finish artifact ownership and retention

Artifact provenance is syntactic only; caller-provided project/environment IDs are not resolved under the principal and have no owner-qualified foreign keys (`apps/runner/src/artifact-store.ts:40-54`, `apps/runner/src/artifact-store-schema.ts:24-45`). Require active owner-qualified records and environment-to-project consistency.

`ArtifactStore.reapExpired` exists but is never scheduled (`apps/runner/src/artifact-store.ts:156-169`, `apps/runner/src/index.ts:15-34`). Expired rows/files accumulate and continue counting against quota. Add a bounded, stoppable reaper with audit/reconciliation.

Before ship, Phase 4 must mount `ARTIFACT_ROOT` on durable runner-confined storage. Current Compose mounts jobs and state only (`compose.yaml:60-75`), while artifacts default to `/var/lib/cloud-harness/artifacts` (`packages/contracts/src/config.ts:56-59`). Container replacement otherwise loses retained snapshots while SQLite metadata survives.

## Mandatory before ship, suitable for Phase 4

- Wire the secret keyring file, artifact storage, Access settings, and GitHub App credentials only to their owning surfaces. Preserve the passing ingress/control/executor boundary.
- Provide an operator key rotation/re-encryption command and backup/restore ordering. `reencrypt()` exists (`apps/runner/src/secret-metadata-store.ts:108-136`) but has no runtime/operator entry point.
- Paginate GitHub installation repositories. The verifier reads one `per_page=100` page, then reconciliation marks absent prior grants removed (`apps/runner/src/github-api-installation-verifier.ts:25-41`, `apps/runner/src/github-installation-sqlite-store.ts:72-88`). Use bounded complete pagination; incomplete reconciliation must not mutate grants.
- Bound pending GitHub setup states. The in-memory map prunes only a presented expired state and loses flows on restart (`apps/runner/src/github-binding-service.ts:20-52`). Persist hashed state with atomic consume/expiry pruning, or explicitly accept restart cancellation while enforcing hard caps and periodic pruning.
- Execute the migration/rollback matrix, image/Docker/e2e gates, sanitized OAuth discovery/login/refresh/revocation/cross-principal checks, and exact merge-SHA CI. Unit tests do not prove configured or live Access.

## Optional advice

- `apps/api/dashboard/dashboard.js` is 343 lines and mixes routing, forms, dialogs, GitHub, files, and runtime views. Split by product section before further growth; this is not itself a release blocker.
- Add a visible retry message for GitHub setup invalidated by runner restart.
- Preserve labels distinguishing retained artifacts/audit metadata from volatile task/session state.

## Verification receipt

- Live GitHub check: issues #13 and #18 are open and labeled `in progress` on 2026-08-17.
- Focused Phase 3/security tests: 10 files, 64 tests passed.
- `npm run verify`: lint, typecheck, 36 test files / 139 tests, and all builds passed.
- `npm run verify:compose`: passed.
- `git diff --check`: passed.
- No image build, Docker/e2e test, Cloudflare/IdP provisioning, OAuth client test, deployment, or production verification was performed.

## Closure guidance

- **#18:** keep open until all mandatory Phase 3 items and Phase 4 persistence/rollout gates are evidenced. This is a substantial implementation, not a complete authenticated dashboard delivery.
- **#13:** keep open until audited subject relink/recovery and owner-authorized Access/IdP verification are complete.
- **Phase 4:** preparation may start, but the formal dependency gate remains blocked on the P0 Phase 3 fixes.

## Unresolved questions

- Should project/environment deletion reject non-empty aggregates or cascade soft deletion? Current UI copy implies cascade; code does neither.
- Should malformed keyring configuration degrade only secret operations, as the plan states, or fail the entire runner? Align readiness, docs, and tests.

**Status:** DONE_WITH_CONCERNS
**Summary:** Core identity isolation and dashboard boundaries are promising and all current tests pass, but concrete untested defects block Phase 3 completion, Phase 4 ship entry, and honest closure of #18.
**Concerns/Blockers:** Access subject relink, GitHub first-install/revocation correctness, complete mutation auditing, aggregate deletion, secret degraded readiness, and artifact ownership/retention/persistence.
