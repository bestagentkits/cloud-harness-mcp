# Final pre-landing code review

Reviewed the latest uncommitted `feature/complete-coding-harness-surface` diff, with emphasis on remote Git credential isolation, path and symlink handling, session/task lifecycle, deployment manifests, contract/worker parity, documentation, and version consistency.

## Findings

No unresolved High, Medium, or Low correctness/security finding remains in the reviewed scope.

## Findings resolved during review

### Safe force-with-lease semantics

The initial implementation refreshed remote-tracking refs immediately before an implicit `--force-with-lease`, which could make an unseen competing commit the lease baseline. The final contract requires a caller-observed `expectedRemoteOid`; the helper invokes exact `--force-with-lease=<destination>:<oid>`, and `test/integration/git-transfer-helper.docker.test.ts:61-77` verifies that a competing remote update is rejected. Push staging also uses an independent bare clone rather than `--shared`, so it does not depend on mutable workspace object storage.

### Normal remote-tracking behavior for `git_fetch`

The first mediated fetch implementation imported only `FETCH_HEAD`. The final helper now imports a default fetch into `refs/remotes/origin/*`; an explicit `refs/heads/<branch>` updates both the matching tracking ref and `FETCH_HEAD` (`worker/git-transfer-helper.sh:41-64`). The focused Docker test asserts `FETCH_HEAD` and `refs/remotes/origin/main` both equal the remote commit (`test/integration/git-transfer-helper.docker.test.ts:50-59`), and `docs/mcp-api.md:89-92` documents the intentionally restricted behavior.

### Deployment failure and manifest bounds

`deployments_run` now returns `ok: false`, `CONFLICT`, the bounded command result, and `isError` for a non-zero exit (`worker/harness-worker.mjs:407-416`); E2E coverage exercises exit 7 (`test/e2e/coding-workflow.docker.test.ts:168-170`). Manifest parsing now rejects files above 256 KiB, more than 100 targets, invalid/overlong names or commands, and unsafe/overlong `cwd` values (`worker/harness-worker.mjs:9-10,125-149`); E2E coverage verifies the byte ceiling (`test/e2e/coding-workflow.docker.test.ts:171-173`).

### Linux host quota traversal for created directories

Post-PR Linux E2E showed that executor-created `0700` directories could not be traversed by the host-side runner process when its UID differs from executor UID 10001, causing the workspace-size scanner to fail. `files_mkdir` now requests `0755` for newly created directories (`worker/harness-worker.mjs:218-224`), and the Docker E2E asserts the outer recursively-created directory is mode `755` before using it (`test/e2e/coding-workflow.docker.test.ts:90-92`). This is correct for the current boundary: the trusted runner needs directory read/traverse permission for quota scanning, while `jobsRoot` remains `0700` (`apps/runner/src/workspace-service.ts:47`) and prevents unrelated host users from reaching repository entries. The change adds no write permission and does not broaden the executor's existing repository authority.

## Boundary and parity assessment

- Credentials remain confined to ephemeral networked helpers. Repository tokens travel over stdin, enter neither Docker arguments nor the long-lived executor, and are cleared with the askpass file. The stored remote remains credential-free; Git system/global configuration, hooks, credential helpers, recursive submodules, tags for explicit transfers, and redirects are constrained.
- Fetch/import and push staging occur in sibling transfer directories that the executor cannot see. The executor is paused during repository import/staging, helpers are capability-free and resource-bounded, and helper containers plus transfer paths are removed in `finally` paths.
- New file mutation paths reject absolute/traversal/root targets and validate parents/ancestors against workspace symlink escape. Within the documented single-owner executor threat model, no host-path escape was found.
- Sessions use separate IDs/maps/names and share bounded output/handle cleanup. Task dependencies are workspace-scoped, unique, backward-only (therefore acyclic), block on failed/cancelled prerequisites, retain referenced prerequisites, and are removed on workspace close. Restart limitations are documented truthfully.
- Public operation names have schemas and either runner interception or worker handlers. Read-only/destructive/open-world annotations for the added surfaces are conservative, and the explicit force lease fields are mutually validated.
- Documentation accurately describes credential isolation, tracking-ref/FETCH_HEAD behavior, restart durability, Ctags definitions versus lexical references, and deployments as repository-controlled unprivileged execution without injected secrets.
- Release metadata is consistently `0.2.0` across the root, API, runner, contracts, lockfile workspace entries, and MCP server identity.

## Verification sampled by this review

- `git diff --check` — passed.
- `npx vitest run packages/contracts/test/contracts.test.ts apps/runner/test/git-transfer-leak.test.ts` — 2 files, 6 tests passed.
- The Docker-backed fetch/tracking, competing-writer lease, and deployment E2E assertions were inspected for failure-sensitive expectations; the independent test pass remains the shipping gate authority.
- The post-PR `0700` to `0755` directory-mode delta and its Linux E2E assertion were reviewed against the jobs-root access boundary; no security or correctness regression was found.

## Landing assessment

No pre-landing blocker remains in the reviewed scope. The current diff is suitable to proceed through the final full verification and ship gates.

Status: DONE
Summary: Final review found the credential boundary, file safety, lifecycle behavior, deployment contract, schema parity, documentation, and 0.2.0 release metadata coherent after the review fixes.
Concerns/Blockers: None.
