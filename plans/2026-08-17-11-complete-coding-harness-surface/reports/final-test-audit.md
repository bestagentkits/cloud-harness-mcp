# Final test audit

Date: 2026-08-17
Branch: `feature/complete-coding-harness-surface`
Version: `0.2.0`

## Result

PASS. The completed coding-harness tool surface passed static validation, unit and contract tests, Docker integration tests, and the MCP end-to-end workflow. The executor image and Docker suites were rebuilt and rerun after the final `git-transfer-helper.sh` changes, including corrected explicit `force-with-lease` expectations and remote-tracking ref import. The settled E2E snapshot also covers deployment command failure, the bounded deployment manifest, private `0700` directories created by `files_mkdir`, execution-plane quota measurement, and interactive shell stream retention.

## Evidence

| Command | Result |
|---|---|
| `bash -n worker/git-transfer-helper.sh` | PASS |
| `node --check worker/harness-worker.mjs` | PASS |
| `npm run test:unit -- --run apps/runner/test/operation-retention.test.ts apps/runner/test/git-transfer-leak.test.ts packages/contracts/test/contracts.test.ts` | PASS, 10 files / 23 tests |
| `npx vitest run packages/contracts/test/contracts.test.ts apps/runner/test/git-transfer-leak.test.ts` | PASS after lease fix, 2 files / 6 tests |
| `npm run verify` | PASS: ESLint, TypeScript, 12 files / 25 tests, and all workspace builds |
| `npm run verify:compose` | PASS, `compose-boundaries=pass` |
| `docker compose --profile images build executor-image api runner` | PASS |
| `docker compose --profile images build --no-cache executor-image` | PASS on final helper snapshot |
| `npm run test:docker` | PASS on final image, 2 files / 4 tests, including competing-writer lease rejection |
| `npm run test:e2e` | PASS on final image, 1 file / 1 workflow test |
| Post-CI-fix `npx vitest run apps/runner/test/operation-retention.test.ts` | PASS, 1 file / 3 tests; interactive commands use `setsid --wait` |
| Post-CI-fix `npm run test:e2e` | PASS, 1 file / 1 workflow test; recursive `files_mkdir` produced mode `700`, quota checks remained available, and shell output was retained |
| `git diff --check` | PASS |

The Docker integration suite exercised executor isolation and the local bare-remote Git transfer helper. The E2E suite exercised the MCP path for file primitives, symbol lookup, named sessions, dependency-aware tasks, deployment manifests, local Git operations, and brokered fetch behavior.

The final review-driven corrections were verified by rebuilding the executor without cache, demonstrating that a competing remote writer is rejected by `force-with-lease`, importing `refs/remotes/origin/*` during fetch, preserving a failing deployment's non-zero result, rejecting a manifest larger than 256 KiB, and then completing the full E2E workflow.

GitHub's Linux E2E exposed that the host-side runner cannot safely traverse every executor-created path when the host and executor UIDs differ. The final fix retains private `0700` directories and moves workspace-size measurement into the execution plane: an active executor runs the fixed `du` command, while pre-executor clone validation uses a capability-free, no-network, read-only helper. A transient measurement failure is retryable and does not close the workspace; overlapping reaper passes are suppressed. The stress E2E uses a 50 ms reaper interval and passed the full file, Git, shell, session, task, and deployment workflow.

The same E2E exposed a separate interactive-stream race: `setsid` may fork when its caller is already a process-group leader, allowing Docker's attached parent to exit before shell input arrives. Both interactive shells and bounded worker calls now invoke `setsid --wait`; the Docker cancellation test additionally verifies that the grace period for terminating the in-container process group prevents delayed commands from leaking after an aborted request.

## Cleanup

After the final Docker and E2E runs:

- `docker ps -a --filter "label=cloud-harness.managed=true"` returned no containers.
- No volume matching `cloud-harness-git-helper-*` remained.
- No broad Docker cleanup or unrelated process/container termination was performed.

## Observation

The first incremental executor rebuild after the final helper edit hit a Docker BuildKit snapshot error (`parent snapshot ... does not exist`). Pulling the pinned base image and rebuilding the executor without cache succeeded. Both Docker test suites then passed against that rebuilt image, so this was an environmental cache issue rather than a product failure.

An initial version of the new oversized-manifest E2E fixture attempted to send more than 256 KiB through a single MCP `files_write` request and was rejected first by Express's HTTP body limit. The fixture was corrected to create the bounded test file through executor-side `exec_run`; the rerun then reached the worker-level manifest validation and passed. No product source was changed by this tester.

## Unresolved questions

None.
