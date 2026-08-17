# Phase 3 integration code review

Verdict: **FAIL — 5 high-severity contract/correctness defects block Phase 3 completion.** Focused verification is green (`12` files, `56` tests), but the failing paths below are not covered.

## Findings

### High — GitHub uninstall reconciliation leaves stale authorization active

`GitHubApiInstallationVerifier` converts provider `404` into `HarnessError('NOT_FOUND')` instead of an `uninstalled` verification result (`apps/runner/src/github-api-installation-verifier.ts:45-53`). `GitHubBindingService.reconcile` does not catch that result and only persists a replacement after successful verification (`apps/runner/src/github-binding-service.ts:91-103`). Therefore an uninstalled App leaves the prior installation `active` and repository grants `granted` in SQLite. The next mint eventually fails at GitHub, but dashboard status and local authorization remain stale, contrary to the explicit uninstall/revocation reconciliation requirement.

Concrete fix: add a principal-scoped transactional `markUninstalled` path that changes installation status, removes every grant, advances generations/check timestamps, and records the redacted audit event when provider verification proves uninstall/404. Test real verifier-404 through binding/service, restart, status, and mint denial.

### High — Artifact and GitHub mutations are not transactionally audited

Artifact create/delete commit storage and metadata inside `ArtifactStore` before control returns (`apps/runner/src/artifact-store.ts:65-95`, `apps/runner/src/artifact-store.ts:125-153`). GitHub binding commits installation/grant changes in its store before return (`apps/runner/src/github-installation-sqlite-store.ts:54-91`). Only afterward does `DashboardControlService` append audit in a separate transaction/SQLite connection (`apps/runner/src/dashboard-control-service.ts:50-76`, `apps/runner/src/metadata-store.ts:163-165`). If audit insertion fails, the mutation persists while the caller receives an error and no audit exists; delete is already irreversible. This violates the Phase 3 transactional-audit and “every mutation auditable” contract.

Concrete fix: make audit append part of the same SQLite transaction as artifact/GitHub metadata state (callback/outbox on the owning connection). Coordinate filesystem staging around that DB transaction as already done for artifact metadata. Add fault-injection tests proving either both mutation and audit commit or neither does.

### High — Soft deletes do not enforce aggregate lifecycle and remain operable/visible

Project/environment list queries return all states (`apps/runner/src/metadata-store.ts:48-50`, `apps/runner/src/metadata-store.ts:94-97`), while delete only marks the selected row and does not transition descendants (`apps/runner/src/metadata-store.ts:81-91`, `apps/runner/src/metadata-store.ts:135-145`). Secret listing/rotation/deletion does not require an active parent environment (`apps/runner/src/secret-metadata-store.ts:37-40`, `apps/runner/src/secret-metadata-store.ts:73-105`). Deleted names also remain protected by unconditional unique constraints (`apps/runner/src/metadata-schema.ts:29-30`, `apps/runner/src/metadata-schema.ts:44-45`, `apps/runner/src/metadata-schema.ts:61-63`). The UI promises deletion of retained child metadata (`apps/api/dashboard/dashboard.js:211-213`), but deleted projects/environments reappear, descendants can still be manipulated, and names cannot be recreated.

Concrete fix: choose and enforce one aggregate contract transactionally: either reject deletion while active children exist, or CAS-soft-delete descendants with audit events. Filter normal list/lookup/mutation paths to active parents/records, and define tombstone/history access separately. Add project→environment→secret deletion and same-name recreation tests.

### High — Per-principal GitHub setup has a first-install bootstrap dependency on a legacy installation

The runner config requires `githubApp.installationId` (`packages/contracts/src/config.ts:69-74`) and only creates the entire GitHub App config when `GITHUB_APP_INSTALLATION_ID` is already present (`apps/runner/src/config.ts:13-15`, `apps/runner/src/config.ts:48-53`). Yet the new setup flow is precisely what obtains a principal installation ID; App JWT verification only needs App credentials and receives the callback installation ID separately. A fresh deployment cannot enable `/github/setup` without first supplying some unrelated/global installation ID. Partial GitHub config also silently disables the feature instead of failing closed.

Concrete fix: split App identity credentials (`appId`, `privateKey`, `appSlug`) from the optional legacy/default installation ID. Require the legacy ID only on owner-bearer mint paths, validate partial configuration as startup error, and test a fresh Access-mode setup with no pre-existing installation.

### High — Secret degraded-readiness mode is unreachable or crashes the runner

Invalid key material is constructed outside any degradation boundary and can abort runner startup (`apps/runner/src/index.ts:17-20`, `apps/runner/src/secret-keyring.ts:31-49`). When the keyring is absent, `secret_list` dereferences the throwing `metadata.secrets` getter before it can return `secretReadiness()` (`apps/runner/src/dashboard-control-service.ts:36`, `apps/runner/src/metadata-store.ts:28-45`). Thus the promised behavior—non-secret dashboard reads remain available while secret metadata reports not-ready—does not work reliably; the readiness payload is unreachable in the missing-key case.

Concrete fix: keep reference-only secret listing independent of decrypt capability, return `{ready:false}` without touching the decrypting store, and map secret mutations/injection to a sanitized `503`. Capture key-construction/unknown-version errors as secret readiness failures when the accepted plan requires degraded operation. Test missing, malformed, and incomplete historical keyrings through the actual runner control endpoint.

### Medium — Artifact provenance is syntactic, not owner-qualified

Artifact provenance columns have no principal-qualified foreign keys (`apps/runner/src/artifact-store-schema.ts:24-45`). Creation only checks string shape/length and stores caller-provided project/environment IDs verbatim (`apps/runner/src/artifact-store.ts:40-54`, `apps/runner/src/artifact-store.ts:79-85`); `DashboardControlService` does not resolve ownership or verify project/environment consistency (`apps/runner/src/dashboard-control-service.ts:50-57`). A principal can therefore attach foreign, deleted, mismatched, or fabricated metadata IDs to a valid owned workspace snapshot, violating the owner-qualified provenance requirement.

Concrete fix: resolve project/environment under the same principal, require environment→project consistency and active state, and add composite foreign keys/owner indexes where practical. Return the same denial for foreign and unknown provenance and test both.

### Medium — GitHub reconciliation treats the first 100 repositories as the complete grant set

The verifier requests exactly one page with `per_page=100` and does not follow pagination (`apps/runner/src/github-api-installation-verifier.ts:25-41`). Both stores mark every previously known grant missing from that partial result as removed (`apps/runner/src/github-installation-sqlite-store.ts:72-88`; equivalent in-memory logic at `apps/runner/src/github-installation-store.ts:74-103`). Installations with more than 100 repositories will lose valid local grants on every reconcile.

Concrete fix: paginate until the complete installation repository set is obtained before `replaceVerified`, enforce an explicit upper/time bound, and fail reconciliation without changing stored grants if completeness cannot be established.

### Medium — GitHub setup state is neither restart-safe nor actually bounded by expiry

Pending setup state exists only in an in-memory `Map` (`apps/runner/src/github-binding-service.ts:20-52`) and is deleted only when the exact state is consumed. Expired states that are never presented remain forever, and every runner restart invalidates all in-flight GitHub callbacks. This misses the persistence/restart and bounded-expiry expectations for the installation ceremony.

Concrete fix: persist only hashed state with principal, expected identities, and expiry in SQLite; consume with one atomic delete/CAS; prune expired rows and cap outstanding states per principal. At minimum, add bounded periodic pruning if restart invalidation is explicitly accepted.

## Verified boundaries

- Public MCP operations remain separate from metadata/internal dashboard schemas: `RunnerRequestSchema` cannot parse Phase 3 operations, and focused contracts assert they are absent from `TOOL_SPECS`.
- BFF response mapping is explicit and does not return submitted secret values, provider tokens, private keys, runner tokens, or artifact paths (`apps/api/src/dashboard-response.ts:53-120`).
- Principal-qualified metadata mutations and artifact lookup/delete use owner predicates; focused cross-principal tests pass.
- Secret ciphertext uses AES-256-GCM with associated data bound to principal/environment/name/version (`apps/runner/src/secret-keyring.ts:22-28`, `apps/runner/src/secret-keyring.ts:92-107`).

## Verification receipt

`npm test -- --run apps/runner/test/metadata-store.test.ts apps/runner/test/secret-keyring.test.ts apps/runner/test/github-binding-service.test.ts apps/runner/test/github-installation-sqlite-store.test.ts apps/runner/test/artifact-store.test.ts apps/runner/test/dashboard-control-service.test.ts apps/runner/test/workspace-environment.test.ts apps/runner/test/internal-runner-app.test.ts apps/api/test/dashboard-router.test.ts apps/api/test/dashboard-ui-behavior.test.ts apps/api/test/dashboard-ui-contract.test.ts packages/contracts/test/internal-runner-api.test.ts`

Result: 12 test files passed, 56 tests passed, 0 failed.

## Unresolved questions

- Should delete cascade retained descendants, or be rejected until the aggregate is empty? Current UI copy says cascade; code does neither.
- Is invalid secret-key configuration intentionally degraded, as the accepted plan states, or should it fail the entire runner closed? Align plan, readiness API, and startup behavior before fixing.
