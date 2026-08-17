# Final pre-ship code review — remediation re-review

Date: 2026-08-17
Scope: the four prior ship blockers only: rollback quiescence/image identity, Cloudflare Access service-token assertions, canary credential export, and long-lived service secret boundaries.

## Verdict

**GO for code ship.** All prior blockers, including the final fail-open quiescence defect, are resolved in current source and focused tests. This is source/test evidence, not a production rollout receipt; Docker image/e2e and live Cloudflare canary/rollback rehearsal remain deployment gates.

## Resolved findings

### Rollback quiescence, sequencing, and containment — resolved

- Stop and containment independently preserve stop/disable and Compose-down failures (`deploy/scripts/release-runtime.sh:23-26`, `deploy/scripts/release-runtime.sh:41-44`).
- Both functions accept only systemd's explicit inactive status 3. A still-active unit or any other state-query result fails closed (`deploy/scripts/release-runtime.sh:27-32`, `deploy/scripts/release-runtime.sh:45-50`).
- Both functions capture `compose ps -q` status separately and fail on query error or non-empty live-container output (`deploy/scripts/release-runtime.sh:33-38`, `deploy/scripts/release-runtime.sh:51-56`).
- Rollback short-circuits after checkout, restore, build, start, readiness, image verification, image recording, or release-record failure and invokes containment before exit 70 (`deploy/scripts/release-runtime.sh:88-116`). Snapshot restoration cannot start unless quiescence succeeded (`deploy/scripts/release-runtime.sh:93-97`).
- Forward deploy and rollback compare each live API/ingress/runner container's immutable Docker image ID against the built local image before recording release metadata (`deploy/scripts/release-runtime.sh:59-73`, `deploy/scripts/deploy-release.sh:49-52`, `deploy/scripts/release-runtime.sh:97-103`).
- Tests execute the real stop and containment functions across stop/disable, down, active, state-query error, remaining container, Compose-query error, and success; the transition fault matrix still proves no advancement after every rollback stage (`test/deploy-release-runtime.test.ts:39-56`, `test/deploy-release-runtime.test.ts:81-110`).

### Cloudflare service-token payload rejection — resolved

Cloudflare's current service-token example uses `type: "app"`, `sub: ""`, a non-empty `common_name`, and no `nbf`. The verifier now:

- identifies only empty-`sub` assertions as services and requires a bounded, trimmed `common_name` (`apps/api/src/access-jwt-verifier.ts:109-118`);
- maps the service client ID into an injective base64url value under reserved `cf-service:` namespace, while rejecting human subjects that use that prefix (`apps/api/src/access-jwt-verifier.ts:7`, `apps/api/src/access-jwt-verifier.ts:113-118`);
- keeps `nbf` mandatory for human assertions, optional but integer-validated when present for service assertions (`apps/api/src/access-jwt-verifier.ts:119-123`); and
- tests the documented empty-`sub`, no-`nbf` shape plus missing/malformed service identity and human-prefix collision cases (`apps/api/test/access-auth.test.ts:52-79`, `apps/api/test/access-auth.test.ts:169-182`).

Provider authority: [Cloudflare Access application-token payload](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#service-token-authentication).

### Non-exported canary credentials — resolved

Access canary inputs now come from the separate `/etc/cloud-harness-mcp/canary-credentials` file. `set -a` surrounds the source operation, so assignments become exported process environment, and Compose passes only the three named values to a transient `run --rm --no-deps` ingress container (`deploy/scripts/deploy-release.sh:68-78`). Values are not placed directly in command arguments or echoed.

### Canary secrets in long-lived services — resolved

- Deploy rejects canary variable assignments in shared runtime configuration and names the separate credential file (`deploy/scripts/deploy-release.sh:11-18`).
- Persistent ingress has no shared environment file; API and runner receive only runtime configuration (`compose.yaml:10`, `compose.yaml:40-59`, `compose.yaml:72`). The one-off canary receives the three values explicitly and is removed afterward (`deploy/scripts/deploy-release.sh:76-78`).
- Compose verification rejects canary variables in API, runner, or persistent ingress and continues to reject runner-only key material in API (`scripts/verify-compose-boundaries.mjs:39-46`).
- Operator documentation matches the executable boundary and calls for a root-owned separate credential file (`docs/deployment.md:163-172`). The maintained configuration template contains no canary secret fields.

## Fresh verification

- `npm test -- --run test/deploy-release-runtime.test.ts`: **passed**, 1 file / 16 tests.
- `npm run verify:compose`: **passed** (`compose-boundaries=pass`).
- `bash -n deploy/scripts/deploy-release.sh deploy/scripts/release-runtime.sh deploy/scripts/rollback-release.sh deploy/scripts/bootstrap-vps.sh deploy/scripts/deploy-ssh-wrapper.sh`: **passed**.
- `git diff --check`: **passed** before this report update.
- Official Cloudflare provider contract rechecked on 2026-08-17: service token has empty `sub`, client ID in `common_name`, and the documented payload omits `nbf`; current code/test matches it.
- Quiescence probes: `systemctl is-active` exit 4 and `compose ps` exit 1 each returned failure status 1 from both `stop_release` and `contain_failed_release`.

Not run in this remediation pass: Docker image builds, Docker/e2e suites, live Access service token, GitHub/Google login, public-edge canary, destructive rollback rehearsal, production deployment, or exact merge-SHA CI. These are rollout evidence, not reopened code blockers.

## Release gate

All reviewed code blockers are closed. Proceed with merge/ship validation, then require exact-head CI and the documented Docker/live Cloudflare canary and rollback rehearsal before claiming production deployment or customer rollout.

Unresolved questions: none.

**Status:** DONE
**Summary:** Final re-review verified fail-closed quiescence and containment plus complete rollback transition short-circuiting; 16 focused tests and shell/diff gates pass. Verdict GO for code ship.
**Concerns/Blockers:** No remaining code blocker in reviewed scope. Live provider, Docker, rollback-rehearsal, deployment, and exact-head CI evidence remain outstanding rollout gates.
