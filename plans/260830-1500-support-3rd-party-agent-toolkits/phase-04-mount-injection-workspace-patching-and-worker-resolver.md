---
phase: 4
title: "Mount Injection, Workspace Patching & Worker Resolver"
status: pending
priority: P1
effort: "2.5d"
dependencies: ["phase-03-preset-adapters-and-provisioning-helpers.md"]
---

# Phase 4: Mount Injection, Workspace Patching & Worker Resolver

## Overview
Connect the runner's resolved toolkit bundles to the workspace executor: compose the owner view using safe reflink/copy projections without mutating CAS inodes, mount `/opt/cloud-harness/owner-skills:ro` read-only, apply confirmed workspace-scope patches with descriptor-safe symlink containment and UID 10001 chown, enforce fast-path idempotency fingerprint comparison, and update `worker/harness-worker.mjs` with full-tree digest validation and immutable execution snapshots to eliminate TOCTOU.

<!-- red-team-applied: Findings 1, 6, 7, 8, 9, 10, 15, 20 -->

## Requirements
- Functional:
  - In `apps/runner/src/workspace-service.ts`:
    - Fast-path idempotency: compare canonical request fingerprint before returning prior workspace; return `CONFLICT` if fingerprint differs.
    - Compose per-workspace owner toolkit projection using `reflink -> copy` fallback into the workspace job directory (`/job/toolkit-projection/owner-skills/`). **Never call chmod on hardlinked CAS files.**
    - Detect same-tier name collisions among selected owner toolkits; fail with `CONFLICT` if skill content hashes differ.
    - Update `createExecutor()` to mount `/job/toolkit-projection/owner-skills:/opt/cloud-harness/owner-skills:ro`.
    - For `workspace` scope, generate a preview write manifest, verify `allowToolkitWorkspaceChanges: true`, enforce canonical root containment without following parent symlinks, apply files atomically, and chown to UID/GID 10001.
    - Recovery precondition: validate that every locked bundle digest is present and valid before transitioning recovery to `ACTIVE`.
  - In `worker/harness-worker.mjs`:
    - Update `computeSkillBundleDigest` to recursively hash all regular files, relative paths, and executable modes.
    - To eliminate TOCTOU execution tampering on writable workspace/repository skills, copy verified skill script to private read-only staging directory before invoking `command()`.
    - Update `skills_list` and `skills_read` to attach `origin` metadata from the bundle manifest to discovered skills.
    - Update `workspace_context` to include owner toolkit bootstrap instruction assets.
- Non-functional:
  - `owner` scope leaves `git status --porcelain` completely clean.
  - Attempts to write to `/opt/cloud-harness/owner-skills` from inside the executor fail (`Read-only file system`).

## Architecture
```text
Runner WorkspaceService
  ├── Idempotency Check: (ownerId, idempotencyKey) + (requestFingerprint)
  ├── Compose /job/toolkit-projection/owner-skills/<skill-name>/ (reflink/copy, no chmod)
  ├── Workspace Patch: Canonical root check, no-follow write, chown 10001:10001
  └── Mount into Executor:
        └── --volume /job/toolkit-projection/owner-skills:/opt/cloud-harness/owner-skills:ro

worker/harness-worker.mjs
  ├── Full-Tree Bundle SHA-256 (paths, bytes, modes)
  ├── Immutable Execution Snapshot (eliminates TOCTOU swap window)
  └── Provenance + Origin Reporting (skills_list, skills_read, workspace_context)
```

## Related Code Files
- Modify: `apps/runner/src/workspace-service.ts`
- Modify: `worker/harness-worker.mjs`
- Create: `apps/runner/test/toolkit-mount-injection.test.ts`
- Create: `apps/runner/test/workspace-toolkit-resolver.test.ts`
- Create: `apps/runner/test/idempotency-fingerprint.test.ts`

## Implementation Steps
1. In `apps/runner/src/workspace-service.ts`:
   - Update `open()` method (lines 598–620):
     - Compute canonical request fingerprint over normalized request JSON.
     - When prior idempotency record found, compare `prior.requestFingerprint === currentFingerprint`; throw `HarnessError('CONFLICT', ...)` on mismatch.
   - Implement `composeOwnerToolkitProjection(record, toolkitBundles)`:
     - Project bundles using reflink with copy fallback from `config.toolkitCacheRoot/<ownerId>/<sha>/skills/*`.
     - Detect same-tier skill collisions across toolkits; throw `CONFLICT` on hash divergence.
   - Update `createExecutor()` volume arguments:
     ```typescript
     '--volume', `${ownerProjectionPath}:/opt/cloud-harness/owner-skills:ro`,
     ```
   - Implement `applyWorkspaceToolkitPatches(record, toolkitBundles)`:
     - Enforce canonical root containment and reject ancestor symlinks (`apps/api/src/local/local-path-policy.ts` pattern).
     - Write files atomically and chown to `10001:10001`.
   - Update recovery path (`ensureActiveExecutor`): verify all locked toolkit bundles on disk; throw explicit error if offline recovery is missing locked bundles.
2. In `worker/harness-worker.mjs`:
   - Refactor `computeSkillBundleDigest(skillDir, skillMdFile)` to traverse the full skill directory recursively, sorting entries and hashing `path:size:mode:sha256`.
   - In `skills_run`: copy verified script to `/tmp/cloud-harness-exec/<runId>/` before spawning to close the TOCTOU execution swap window.
   - Update `skills_list` and `skills_read` to surface `origin` metadata from `bundle/manifest.json`.
3. Write test suite in `apps/runner/test/toolkit-mount-injection.test.ts` and `apps/runner/test/idempotency-fingerprint.test.ts`:
   - Test idempotency replay matches fingerprint; mismatched replay returns `CONFLICT`.
   - Test owner projection leaves `git status` 100% clean.
   - Test workspace patch chown allows in-container UID 10001 edits.
   - Test full-tree bundle digest detects file content or mode tampering.
   - Test TOCTOU script swap is prevented.

## Success Criteria
- [ ] Remote container mounts `/opt/cloud-harness/owner-skills:ro` read-only.
- [ ] Fingerprint comparison correctly blocks dirty idempotency replays.
- [ ] Full-tree digest and immutable execution snapshot pass security tests.

## Risk Assessment
- *Risk:* Hardlink inode chmod mutates source CAS.
  - *Mitigation:* Explicitly ban chmod on hardlinks; use reflink/copy for projection.
