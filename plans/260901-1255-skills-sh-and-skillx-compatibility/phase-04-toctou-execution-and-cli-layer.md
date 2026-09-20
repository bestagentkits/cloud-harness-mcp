---
phase: 4
title: "TOCTOU-Safe Helper Execution & Executor CLI Compatibility Layer (TDD)"
status: pending
priority: P1
effort: "16h"
dependencies: [2, 3]
---

# Phase 4: TOCTOU-Safe Helper Execution & Executor CLI Compatibility Layer (TDD)

## Overview
Harden `skills_run` against Time-of-Check to Time-of-Use (TOCTOU) race conditions by executing scripts from an immutable, root-owned snapshot in a dedicated helper container. Implement and package the offline CLI compatibility layer (`skills`, `skillx`, and the narrow `npx` dispatcher) inside the executor image to support native commands in air-gapped (`networkMode: 'none'`) workspaces.

## Requirements
- **Functional:**
  - TOCTOU-Safe Execution:
    - Current reality this phase builds on: `skills_run` is a worker operation routed through `runWorker` (`apps/runner/src/workspace-service.ts:3843`) and implemented in `worker/harness-worker.mjs`, which stages the script into `/tmp/cloud-harness-exec/<runId>`, verifies `computeSkillBundleDigest` against `expectedContentSha256` / `expectedSha256`, makes the snapshot read-only, and then runs it as a **local child process** via `command()`. No helper container exists today, and there is no provenance gate to replace.
    - Keep that worker-side staging and digest path as the primary control; this phase does not replace it. What changes is where the verified bytes execute.
    - The disposable container is spawned on the **runner** side through the existing ephemeral-container authority `runPrivilegedEphemeralExec` (`apps/runner/src/workspace-service.ts:1718`), which requires an owner approval grant. State in the implementation whether the container path is gated on that grant (falling back to the current local child-process path and reporting `executionMode: 'local'`) or whether the grant becomes mandatory for `skills_run`; do not leave both readers guessing.
    - The runner re-verifies the digest after staging, so the bytes that are mounted are the bytes that were verified rather than a second read of a mutable path.
    - Introduce the error code `NO_EXECUTABLE_ASSETS` in this phase for instruction-only revisions that carry no script, replacing the generic `NOT_FOUND` used today.
    - Container execution uses UID/GID `10001:10001`, dropped capabilities, `no-new-privileges`, and the workspace network profile (`none` by default).
  - CLI Compatibility Wrappers:
    - Build `skills` binary in `worker/` supporting:
      - `skills add <owner/repo>` (with `--skill <name>`, `-y`, `--agent`) resolving from `/opt/cloud-harness/skill-catalog.json`.
      - Interactive TTY selection from available catalog items.
      - `skills list` and `skills remove`.
    - Build `skillx` binary in `worker/` supporting:
      - `skillx use <slug> [--raw] [--include-refs] [--search]`.
    - Build a narrow `npx` dispatcher. Do not install it over the real `npx`: the executor image is `node:24.11.0-bookworm-slim` (`docker/executor.Dockerfile:4`) and Node's official Debian images put `node`, `npm`, and `npx` in `/usr/local/bin`, so `/usr/bin/npx` does not exist and writing the dispatcher to `/usr/local/bin/npx` would make the delegation path call itself.
      - Install the dispatcher at `/opt/harness/bin/npx` and prepend `/opt/harness/bin` to `PATH` in the existing `/etc/profile.d/harness.sh` (`docker/executor.Dockerfile:36-37`), which already owns the PATH line.
      - Dispatches `skills` and `skillx-sh` / `skillx` to the local compatibility binaries.
      - Transparently delegates all other invocations (e.g. `npx tsc`, `npx prettier`) to the real `npx` at `/usr/local/bin/npx`.
      - Assert the resolved paths in `cli-compatibility-airgap.docker.test.ts`: `command -v npx` resolves to `/opt/harness/bin/npx` and `npx --version` returns npm's version through delegation.
- **Non-functional / Security:**
  - When running in `networkMode: 'none'`, all CLI commands execute 100% offline from the local projection without attempting network connections.
  - A cache miss for an unmirrored skill fails closed with exit code 1 and error code `CACHE_MISS`, outputting exact import instructions.
  - Ensure zero credentials, tokens, or control-plane sockets are accessible to the CLI or execution container.

## Architecture
```text
In-Workspace CLI (skills / skillx / npx)
                │
                ▼ (reads local catalog index)
/opt/cloud-harness/skill-catalog.json (ro) + /opt/cloud-harness/owner-skills/ (ro)
                │
                ▼ (offline execution or cache-miss fail closed)
Output result / copy to .cloud-harness/skills/

─────────────────────────────────────────────────────────────

skills_run Invocation (MCP Tool)
                │
                ▼
Runner Staging & Digest Verification
                │ (snapshot mutable script -> re-hash -> compare expectedSha256)
                ▼
Spawn Disposable Helper Container
  - UID/GID 10001:10001
  - Skill snapshot: mounted read-only (:ro)
  - Workspace checkout: mounted (:rw)
  - Network: none (default)
  - Capabilities dropped: ALL
  - no-new-privileges: true
```

## Related Code Files
- Modify: `apps/runner/src/workspace-service.ts`
- Modify: `worker/harness-worker.mjs`
- Create: `worker/bin/skills`
- Create: `worker/bin/skillx`
- Create: `worker/bin/npx-dispatcher`
- Modify: `docker/executor.Dockerfile`
- Create: `apps/runner/test/toctou-script-tamper.test.ts`
- Create: `apps/runner/test/cli-compatibility-airgap.test.ts`
- Create: `apps/runner/test/cli-compatibility-airgap.docker.test.ts`

## Implementation Steps
1. **Tests-First (TDD):**
   - Write unit and adversarial tests in `apps/runner/test/toctou-script-tamper.test.ts`:
     - Test that modifying or replacing a skill script in the workspace directory while `skills_run` is validating does not execute the modified bytes.
     - Test that symlink swaps pointing to sensitive host paths are rejected during snapshot staging.
     - Test that script execution executes with UID 10001 and read-only skill mounts.
   - Write fixture-level tests in `apps/runner/test/cli-compatibility-airgap.test.ts` (unit lane, no containers):
     - Test that every launcher parser reads `/opt/cloud-harness/skill-catalog.json` fixtures and resolves a catalog entry to a local bundle path.
     - Test that `skills add unmirrored/repo` exits 1 with `CACHE_MISS` and prints import instructions.
     - Test that the dispatcher resolves `skills` and `skillx` locally and passes every other argument vector through unchanged, using a stubbed real-`npx` path.
   - Write container tests in `apps/runner/test/cli-compatibility-airgap.docker.test.ts` (Docker lane, `npm run test:docker`):
     - Test running `skills add owner/repo --skill foo -y` in a `networkMode: 'none'` workspace installs to `.cloud-harness/skills/` with no DNS or outbound attempt.
     - Test running `npx skills add` produces identical output to the direct binary.
     - Test running `skillx use slug --raw` outputs the instructions snapshot.
     - Test running an unrelated `npx` command reaches the real npm through delegation and prints the npm version.
2. **Implement TOCTOU-Safe Runner Execution:**
   - Keep the worker-side staging, digest verification, and read-only snapshot in `worker/harness-worker.mjs` as the primary control, and add the runner-side re-verification plus the disposable-container spawn through `runPrivilegedEphemeralExec` in `apps/runner/src/workspace-service.ts`.
   - Make the approval-grant behaviour explicit in code and in the response: either `executionMode: 'container'` after a grant, or `executionMode: 'local'` with the worker path when no grant exists.
   - Add the `NO_EXECUTABLE_ASSETS` failure for instruction-only revisions.
3. **Build CLI Compatibility Launchers:**
   - Implement `worker/bin/skills` CLI parser in Node.js.
   - Implement `worker/bin/skillx` CLI parser in Node.js.
   - Implement `worker/bin/npx-dispatcher`, installed at `/opt/harness/bin/npx`, with the real `npx` preserved at `/usr/local/bin/npx`.
   - Update `docker/executor.Dockerfile` to copy the launchers with `COPY --chown=root:root worker/bin/<launcher> /opt/harness/bin/<launcher>` and `RUN chmod 0555 /opt/harness/bin/*`, mirroring the existing `/opt/harness` block at lines 42-49, and extend the `/etc/profile.d/harness.sh` PATH line with `/opt/harness/bin`.
4. **Verification:**
   - Run `npm test apps/runner/test/toctou-script-tamper.test.ts` and `npm test apps/runner/test/cli-compatibility-airgap.test.ts`.
   - Run `npm run test:docker` for `apps/runner/test/cli-compatibility-airgap.docker.test.ts`, and confirm the image builds with `docker compose --profile images build executor-image`.

## Success Criteria
- [ ] Symlink swapping or file tampering during `skills_run` cannot alter executed bytes.
- [ ] `skills add` and `skillx use` execute completely offline inside `networkMode: 'none'` containers.
- [ ] `npx skills ...` and `npx skillx-sh ...` work seamlessly without requiring npm registry connections.
- [ ] Unrelated `npx` commands continue to work normally through delegation.
- [ ] Uncached skill requests fail closed with structured `CACHE_MISS` errors.
- [ ] The executor image is built from `docker/executor.Dockerfile`, contains the launchers, and resolves `npx` to `/opt/harness/bin/npx` while delegation still reaches the real npm.

## Risk Assessment
- **Risk:** Shell environment differences or non-standard `npx` arguments breaking delegation.
- **Mitigation:** The `npx-dispatcher` only intercepts exact command invocations matching `skills` and `skillx-sh`/`skillx`; all flags and arguments for other tools pass directly to the real `npx` at `/usr/local/bin/npx` unchanged.
