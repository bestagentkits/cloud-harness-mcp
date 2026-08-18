---
title: Dashboard-managed API-key verification
date: 2026-08-18
status: done-with-concerns
branch: codex/feat/dashboard-api-keys
base_head: 87958e9
---

# Summary

Final working-tree implementation passes focused tests, Compose boundary verification, and the full non-Docker repository gate. Testing found one real UI contract mismatch: the BFF returned `publicUrl` at a different shape than the renderer consumed. A regression assertion was added, the implementation was fixed, and the focused/full gates passed afterward.

Docker-backed verification is not a pass. The executor image rebuilt successfully from this working tree, but API and runner image builds stalled during `npm ci`; the local Docker integration and E2E suites subsequently hit their existing fixed timeouts. No assertion showed an API-key feature defect, but exact-head hosted Docker evidence is still required before claiming the complete ship gate.

# Verification results

| Gate | Result | Evidence |
|---|---|---|
| Focused contracts/runner/API/dashboard/Worker | PASS | 10 files, 90 tests |
| `npm run verify:compose` | PASS | `compose-boundaries=pass` |
| `npm run verify` | PASS | lint, typecheck, 46 files / 258 tests, builds, Wrangler dry-run |
| Executor image build | PASS | rebuilt `cloud-harness-executor:local` from current working tree |
| API/runner image build | UNAVAILABLE | both stalled at `RUN npm ci`; stopped cleanly after more than 10 minutes |
| `npm run test:docker` | UNAVAILABLE | 2 files failed on timeouts: 10s setup and 120s test; 1 failed, 3 skipped |
| `npm run test:e2e` | UNAVAILABLE | coding workflow reached fixed 120s timeout; 1 failed |
| Live production canaries | NOT RUN | deployment/owner-credential gate, outside local test scope |

# Acceptance coverage

- G1-G3: route separation, dedicated audience/subject validation, Worker host/header enforcement covered by contracts, API gateway-auth, and Worker tests.
- G4-G6: key format, hash-only persistence, durable principal mapping, expiry bounds, and transactional active-key limit covered by contracts and runner store/service tests.
- G7-G10: safe response metadata, uniform invalid-key behavior, coalesced usage tracking, and audit events covered by focused API/runner tests. Safe synthetic sentinels only; no real secrets used.
- G11: public `TOOL_SPECS`, OAuth flow, and owner bearer behavior remained covered by the full 258-test repository suite.
- G12: migration up/down and restart behavior covered by metadata/store tests; Docker restart evidence remains unavailable because the suite timed out.
- G13: live valid/revoked/expired/wrong-host/OAuth canaries were not executed locally.

# Regression added

`apps/api/test/dashboard-ui-behavior.test.ts` now asserts that the configured API-key MCP endpoint is rendered, while raw keys and internal hashes are absent. Existing UI tests also verify one-time reveal, clipboard-failure clearing, acknowledgement clearing, and removal of the JS-held secret.

# Docker diagnosis and cleanup

- `test:docker` and `test:e2e` import current working-tree TypeScript sources and use the freshly rebuilt executor image; they were not stale-image-only runs.
- API/runner image builds emitted Node engine warnings for release-only dependencies, then stopped producing output during `npm ci`.
- Timeouts were not increased and assertions were not weakened.
- The owned build was interrupted cleanly. Final inspection found no Cloud Harness managed containers, matching test volumes, Vitest/E2E process, or orphaned Compose/build process.

# Concerns

- Do not label the API/runner image build, Docker integration suite, or E2E suite as passing.
- Require exact-head hosted CI or a successful local rerun for those gates before merge/release claims.
- No coverage percentage was collected because the repository defines no coverage threshold command; the repository-owned `verify` gate is green.

# Unresolved questions

None.
