# Phase 3: Compound GitHub Action & Snapshot-Bound Cursors

## Objectives
- Implement `issue_publish` in `worker/gh-helper.sh` and `apps/runner/src/workspace-service.ts`.
- Implement snapshot-bound cursors in `worker/harness-worker.mjs`:
  - `files_read`: encode `<offset>:<fileSha>` in cursor; return `CONFLICT` if file changed.
  - `git_diff`: encode `<offset>:<headSha>` in cursor; return `CONFLICT` if HEAD commit changed.
  - `git_log`: encode `<offset>:<headSha>` in cursor; return `CONFLICT` if HEAD commit changed.

## Affected Files
- `worker/gh-helper.sh`
- `worker/harness-worker.mjs`
- `apps/runner/src/workspace-service.ts`
- `apps/runner/test/ux-improvements.test.ts`
- `apps/runner/test/batch-write-worker.test.ts`
