# Phase 3 remediation re-review

Date: 2026-08-17
Scope: current Phase 3 implementation after remediation of the four NO-GO findings from the first review.

## Verdict

**GO for Phase 3 application-code remediation and handoff to the Phase 4 ship/operations gates.**

All four prior blockers are closed in the live source and covered by focused fault-path tests. No new Phase 3 correctness or contract finding was identified in the reviewed changes.

This GO is not production-deployment evidence. Live Cloudflare Access/Google/GitHub SSO, Docker/e2e, migration/rollback, exact-head CI, credential provisioning, and production verification remain separate Phase 4 gates.

## Four-finding re-review

### Closed — invalid secret configuration no longer aborts the runner

`SECRET_KEYRING` is parsed and validated independently with a sanitized failure result (`apps/runner/src/config.ts:19-31`). Invalid material is omitted from the general runner schema, so unrelated configuration and non-secret control surfaces remain constructible (`apps/runner/src/config.ts:39-73`). Startup carries that readiness error into `MetadataStore`, while runtime key construction remains separately guarded (`apps/runner/src/index.ts:16-27`).

Tests prove malformed JSON, schema-invalid material, and missing configuration behavior without exposing validation detail (`apps/runner/test/runner-config-readiness.test.ts:10-34`). Historical-key/runtime construction degradation remains owned by `MetadataStore` and `SecretKeyring` coverage.

**Disposition:** prior High finding closed.

### Closed — file/close audit remains truthful when terminal audit persistence fails

Each audited file mutation persists `workspace.file_mutation.requested` before invoking the worker (`apps/runner/src/workspace-service.ts:561-563`). Terminal outcome append is isolated in a non-throwing helper (`apps/runner/src/workspace-service.ts:664-674`), so an audit-store failure cannot convert a completed operation into a false `failed` result. A missing terminal event is represented by the durable request event and emits an operator-visible reconciliation warning.

Generation-fenced close follows the same model: request before the lifecycle claim/side effect, truthful close result after cleanup, and best-effort terminal outcome (`apps/runner/src/workspace-service.ts:622-650`). The request append itself is strict; if it cannot be persisted, no external mutation starts.

Fault tests prove a successful file change and successful close still return their true result, leave only the durable request event, and never append a false failure (`apps/runner/test/workspace-audit.test.ts:131-149`, `apps/runner/test/workspace-audit.test.ts:188-205`). Worker/close failures continue to produce failure outcomes when persistence is available.

**Disposition:** prior High finding closed. The implemented durable-intent/incomplete-outcome semantics satisfy the advice requirement without pretending filesystem/container work can be atomic with SQLite.

### Closed — artifact provenance is revalidated under the artifact writer transaction

The early validation still rejects invalid requests before workspace file I/O (`apps/runner/src/dashboard-control-service.ts:53-61`). More importantly, the artifact callback revalidates the active owner-qualified project/environment immediately before audit/commit (`apps/runner/src/dashboard-control-service.ts:62-75`). `ArtifactStore.create` acquires `BEGIN IMMEDIATE` before insertion and callback, and commits only after the callback succeeds (`apps/runner/src/artifact-store.ts:65-96`).

Because project/environment deletion is another SQLite write, it cannot commit between this in-transaction revalidation and artifact commit. If deletion won the writer lock first, revalidation observes the deletion and the artifact/file staging rolls back. The coordinated regression test deletes provenance during the awaited workspace read and proves artifact creation is denied with no retained artifact (`apps/runner/test/dashboard-control-service.test.ts:91-106`).

**Disposition:** prior Medium TOCTOU finding closed.

### Closed — GitHub authentication and pagination share one wall-clock deadline

The verifier builds an Octokit request transport whose fetch receives the remaining deadline as an abort signal (`apps/runner/src/github-api-installation-verifier.ts:41-55`). Both App authentication and installation-token authentication are also wrapped in the same Promise deadline (`apps/runner/src/github-api-installation-verifier.ts:56-65`, `apps/runner/src/github-api-installation-verifier.ts:151-166`). Repository pagination continues to use that same deadline and bounded page/repository limits.

The new test injects an installation-auth promise that never settles and proves verification returns `TIMEOUT` within the configured bound (`apps/runner/test/github-api-installation-verifier.test.ts:76-86`). This covers the path missing from the first review rather than only page fetches.

**Disposition:** prior Medium timeout finding closed.

## Original eight findings

| # | Finding | Final disposition |
|---|---|---|
| 1 | GitHub uninstall leaves stale authorization | **Resolved** — provider 404 transactionally marks uninstall and removes grants. |
| 2 | Mutation audit gaps / non-atomic artifact and GitHub audit | **Resolved** — SQLite mutations audit in their owning transactions; filesystem/close use strict durable intent plus truthful terminal outcomes. |
| 3 | Broken aggregate deletion | **Resolved** — active aggregates delete descendants transactionally and allow name reuse. |
| 4 | First Access GitHub installation requires a global installation ID | **Resolved** — Access setup verifies the selected installation without a legacy default ID. |
| 5 | Secret degraded readiness crashes or is unreachable | **Resolved** — reference reads remain available; missing, malformed, invalid, and runtime-invalid keyring states degrade secret operations only. |
| 6 | Artifact provenance is syntactic | **Resolved** — active owner/project/environment consistency is checked and revalidated under the artifact writer transaction. |
| 7 | GitHub reads only the first 100 repositories | **Resolved** — complete bounded pagination plus one wall-clock deadline, including token acquisition. |
| 8 | GitHub setup state is process-local/unbounded | **Resolved** — hashed persisted state, expiry pruning, per-principal cap, and atomic consume. |

The advice additions for exact audited principal relink, durable artifact mount, and bounded artifact reaper remain present and were not regressed by this remediation cycle.

## Fresh verification

Focused fault-path suite:

```text
npm test -- --run \
  apps/runner/test/runner-config-readiness.test.ts \
  apps/runner/test/workspace-audit.test.ts \
  apps/runner/test/dashboard-control-service.test.ts \
  apps/runner/test/artifact-store.test.ts \
  apps/runner/test/github-api-installation-verifier.test.ts \
  apps/runner/test/metadata-store.test.ts
```

Result: **6 files passed, 42 tests passed, 0 failed** (2.95s).

Workspace typecheck:

```text
npm run typecheck
```

Result: **passed** for contracts build, API typecheck, and runner typecheck.

`git diff --check` for this report also passed.

## Gate decision

Phase 3 code remediation may be marked complete and passed to Phase 4. Do not conflate this with permission or evidence to deploy: the live identity-provider, Cloudflare, GitHub OAuth/App, Docker/e2e, migration, rollback, CI, and production receipts listed in the plan still govern shipping and issue closure.

Unresolved questions: none.

**Status:** DONE
**Summary:** Re-reviewed all four NO-GO findings against live source and fresh tests; each is closed. Final Phase 3 application-code verdict is GO.
**Concerns/Blockers:** none within the reviewed Phase 3 remediation; Phase 4 live/operational gates remain pending.
