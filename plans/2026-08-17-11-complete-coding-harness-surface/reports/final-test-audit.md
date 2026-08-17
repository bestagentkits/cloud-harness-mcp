# Final test audit

Date: 2026-08-17
Branch: `feature/complete-coding-harness-surface`
Version: `0.2.0`

## Result

PASS. The completed coding-harness tool surface passed static validation, unit and contract tests, Docker integration tests, and the MCP end-to-end workflow. The executor image and Docker suites were rebuilt and rerun after the final `git-transfer-helper.sh` changes, including corrected explicit `force-with-lease` expectations and remote-tracking ref import. The final E2E run also covered deployment command failure and the bounded deployment manifest.

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
| `git diff --check` | PASS |

The Docker integration suite exercised executor isolation and the local bare-remote Git transfer helper. The E2E suite exercised the MCP path for file primitives, symbol lookup, named sessions, dependency-aware tasks, deployment manifests, local Git operations, and brokered fetch behavior.

The final review-driven corrections were verified by rebuilding the executor without cache, demonstrating that a competing remote writer is rejected by `force-with-lease`, importing `refs/remotes/origin/*` during fetch, preserving a failing deployment's non-zero result, rejecting a manifest larger than 256 KiB, and then completing the full E2E workflow.

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
