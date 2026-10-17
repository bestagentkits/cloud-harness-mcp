# Verification review: `bash` MCP tool (issue #312, P1)

- Branch: `claude/determined-gates-scf47h`, range `origin/dev...HEAD` (46958a4, 2460ea8, edb0d58, 11d5a3b, dad5e1a, 08bccc9). 36 files, +1523/-53.
- Prior review: `plans/reports/code-reviewer-261013-0903-bash-tool-p1-review.md`.
- Checks run:
  - Focused vitest, 8 files: toolbox-runner, bash-tool, bash-tool-contract, concurrent-workspaces, ux-improvements, both local backends, skill contract. Run 3 times: **1 run failed** (see M1 below) and 2 runs passed 114/114. `toolbox-runner.test.ts` passed 4 of 4 times when run alone.
  - `npm run typecheck` clean. eslint on the touched sources and tests clean.
  - `verify-docs-reference.mjs` reports no drift. `plugin:check` reports the copies are byte-identical.
  - Docker suites were not run, as instructed.

## Verdict

The earlier High and Medium findings are fixed:
- create, then start and attach, then verified removal by exact name
- a runner-wide concurrency cap
- daemon failures mapped to `UNAVAILABLE`
- async toolbox handles scoped to their owner
- an in-container `timeout`, plus a periodic sweep scoped to this instance's labels

The stricter handle scoping does not break any existing path, and no principal can reach another principal's handle. Executor hardening parity holds.

The fixes introduced one test flake. The same flake exposes a wrong fallback in the start-refusal mapping. There are a few low-severity races and edge cases. Nothing blocks the slice on trust-boundary grounds. Fix the flake before merge so CI stays green.

## Prior findings: verification

| Prior | Status | Evidence |
|---|---|---|
| H1 container leak on early abort | Fixed | `toolbox-runner.ts:184-189`: `docker create` is not interrupted, and abort or timeout is checked only after it returns. `:191-217`: `start --attach` is spawned synchronously after that check, so there is no gap. `:227-231` and `:135-145`: `removeUntilGone` retries `rm -f` and stops only when inspect reports no such container, or after 10 s. Residual case: if the create CLI itself times out (30 s) before the daemon registers the name, `containerAbsent` reports true at once and the late container waits for the sweep (`TOOLBOX_STALE_AFTER_MS` = 360 s). That matches the documented backstop. |
| H2 no concurrency cap | Fixed | `workspace-service.ts:2134-2137,2141-2153`. The check and `liveToolboxContainers.add` run in the same synchronous turn on both the sync and async paths, so there is no check-then-act race. The slot is released in `.finally`, after verified removal. A `registerGenericOperation` throw (the 500-handle cap) happens before `run()`, so no slot leaks. `toolboxMaxConcurrent` is in the schema (1-16, default 2) and `.env.example`, and is documented. |
| M1 daemon failures reported as exit codes | Fixed with one caveat | Create failure maps to `UNAVAILABLE` (`:187`). A start refusal is detected through `State.StartedAt` (`:223-225`). The fallback used when inspect fails is wrong; see L1. |
| M2 toolbox could not return a handle | Fixed | Async toolbox handle `kind:"bash"` (`workspace-service.ts:2156-2174`). Docs and skill steer long commands to `async: true`. A sync toolbox call is still bounded by the API deadline, the same as `exec_run`. |
| M3 no in-container deadline or sweep | Fixed | `/usr/bin/timeout -k 5s <ceil(t)+2>s` (`toolbox-runner.ts:115`). The executor image has the `tini` ENTRYPOINT and Debian coreutils (`docker/executor.Dockerfile:18,87`). The sweep is in `reapExpired` (`workspace-service.ts:4507`). |
| L1 "exited with 1" on signal | Fixed | `toolboxResponse` reports the signal (`workspace-service.ts:4789-4791`). |
| L2 shell environment | Fixed | `bash -lc` sources `/etc/profile.d/harness.sh`, which puts `/opt/harness/bin` first. The `/workspace/node_modules/.bin` entry is harmless when absent. |
| L4 NUL byte | Fixed | `shellCommand` refine is shared by `exec_run` and `bash` (`tool-schemas.ts:569`). |
| L5 async workspace result without target | Fixed | `resultTarget` passes through `handleExecRun` (`:2097`). The start response is wrapped at `:3644`. The docs state that `kind` is `exec_run`. |

## Focus-area verification

**Operation handle owner scoping (`workspace-service.ts:2429-2436`, `operation-manager.ts:50-54,1004-1006`).**
- A handle is returned only when one of these holds:
  - its workspace belongs to the caller (`byOwnerAndId`), or
  - it has no workspace and `op.ownerId === ownerId`, where `ownerId` is the resolved principal.
- A handle with neither is invisible to everyone.
- `operation_status`, `operation_cancel` and `operation_wait` all go through `ownedOperation` first. The wait loop re-reads by the same verified id. Cross-owner NOT_FOUND is tested for all three (`bash-tool.test.ts:266-270`).
- Regression check: every other `registerGenericOperation` caller passes `workspaceId`:
  - `runWorker` at `:1585`
  - async `exec_run` at `:2063`
  - task records mapped through `getGenericOperation`, which carry `task.workspaceId`
- Before this change a workspace-less handle was readable by any principal. It is now strictly narrower, and no existing path depends on the old behaviour.
- Caller-supplied `operationId` cannot collide with or overwrite a handle: no non-operation schema accepts `operationId`, and zod strips unknown keys before `runWorker` reads `input.operationId`.

**Reaper scoping (`toolbox-runner.ts:245-267`).**
- It filters on all three labels: `role=toolbox`, `ephemeral=true`, `instance=<id>`. Docker ANDs the filters.
- The instance id is regex-validated. Names must match `^chm-toolbox-[a-f0-9]{16}$`.
- Live names are excluded, and only containers older than 360 s are removed.
- There is no broad cleanup and no prune.

**Hardening parity.**
- The workspace executor and the toolbox share the frozen `EXECUTOR_HARDENING_ARGS`: uid 10001, `--read-only`, tmpfs, `cap-drop ALL`, `no-new-privileges`, and the pids, memory, CPU and nofile limits.
- The toolbox adds `--network none`, `--pull never` and fixed `--env` values only. It has no `--volume`, `--env-file`, Docker socket or credentials, and `mounts: []` is hard-coded at `workspace-service.ts:2150`.
- Mount paths are validated against option injection, though none are used yet.

**Contract consistency.**
- The schema, generated `docs-site/reference/tools.md`, `docs/mcp-api.md`, `docs/security-model.md`, `docs/configuration.md`, the ADR, the skill and plugin copy (identical), `.env.example` and `environment-variables.md` agree, except for the minor gaps in L4 and L6.

## Critical

None.

## High

None.

## Medium

### M1. Flaky unit test: "maps a start the daemon refuses to UNAVAILABLE"

Location: `apps/runner/test/toolbox-runner.test.ts:287-290`. The root cause is in the fake at `:20-27` and `:108-111`.

**Observed.** In 1 of 3 runs of the 8-file focused set, the call resolved to `{ exitCode: 1, output: "Error response from daemon: unable to find user nosuchuser" }` instead of rejecting with `UNAVAILABLE`. The file passed 4 of 4 times when run alone.

**Cause.**
- `FakeChild.write` emits data in `setImmediate` and drops it once `closed` is set.
- `inspect` and `start` call `close` in `setTimeout(…, 1)`.
- Under load the 1 ms timer has already expired when the event loop reaches the timers phase. `close()` then runs before the check-phase `setImmediate`, so the inspect stdout is dropped.
- `containerState` then returns `undefined`, and the code falls through to the `attached.code === 125` fallback (L1). The fake's `start` exits with 1, so the call reports an exit code.

**Impact.** Intermittent red CI on the branch that gates `main`, which triggers a production deploy.

**Fix.** Make the fake order-deterministic:
- emit data and then close in the same deferred callback, for example `setImmediate(() => { emit data; emit close })`; or
- have `close()` flush queued writes before it emits `close`.

Do not paper over it with retries.

## Low

### L1. The fallback for an uninspectable start uses the `docker run` exit code

Location: `apps/runner/src/toolbox-runner.ts:225`.

- `state ? !state.started : attached.code === 125` assumes `docker run` semantics.
- `docker start --attach` exits with 1 for a daemon refusal ("Error response from daemon … failed to start containers").
- If the follow-up `inspect` fails (a daemon hiccup, or the 10 s inspect timeout), a refused start is reported as `ok:true, exitCode:1`, with the daemon text as command output. That is the M1 defect from the earlier review, still present on this branch.
- The reverse also happens: a real command that exits 125 is reported as `UNAVAILABLE` whenever inspect fails.

Fix: when `state` is undefined, return `UNAVAILABLE` ("toolbox container state could not be read"). The runner cannot confirm that the command ran, and retryable `UNAVAILABLE` is the honest answer.

### L2. A command that ends right at the deadline is reported as TIMEOUT

Location: `toolbox-runner.ts:179,213-228`.

- The timer is cleared only in `finally`, after the `containerState` inspect, which can take up to 10 s.
- If the command exits on its own and the timer fires during that inspect, `timedOut` becomes true while `requestStop` is already undefined.
- The result is `ok:false, TIMEOUT` for a command that completed with a real exit code.
- The window is the inspect latency, usually tens of milliseconds, so this is rare.

Fix: snapshot `timedOut` (or clear the timer) in the `close` handler, and decide the result from that snapshot.

### L3. `operation_cancel` on a toolbox handle can outlast the API deadline

Location: `operation-manager.ts:1075` (`await op.completion`), with `toolbox-runner.ts:184,196,135-145`.

- Cancel waits for the run to settle. The worst case adds up to more than 60 s:
  - an uninterruptible `create` (up to 30 s)
  - the stop's `rm -f` (up to 30 s, because `removeContainer` uses `timeoutMs: 30_000`)
  - `removeUntilGone` (up to 10 s, plus inspect time)
- That exceeds the default 60 s API `requestTimeoutMs`. The client sees a transport timeout even though the handle is already `cancelled`.
- No resource leaks, because the run still finishes cleanup in the background.

Fix: bound the wait, for example with `Promise.race([op.completion, delay(15_000)])`, and return the `cancelled` status. Document that removal can finish after the cancel response.

### L4. The sweep aborts on the first removal failure

Location: `toolbox-runner.ts:263`.

- `removeContainer` throws `UNAVAILABLE` on any non-"No such container" failure. The loop then stops, and the caller swallows the error (`workspace-service.ts:4507`).
- One container stuck in "removal in progress" therefore blocks the sweep of every later container on every pass.

Fix: wrap each removal (`await removeContainer(name).then(() => removed.push(name), () => undefined)`) so one failure skips only that container.

### L5. The toolbox cap is shared by all principals

Location: `workspace-service.ts:2134-2137`.

- In `cloudflare-access` mode one principal can hold every slot with async `sleep 300` runs, up to 300 s each, and refuse every other principal with `LIMIT_EXCEEDED`.
- This is consistent with the single-owner threat model and the global `PACKAGES_ENABLED` flag, but it is not documented as a cross-principal effect.
- Fix: document it in `docs/configuration.md`, or add a per-owner sub-cap later. This is product intent; see the unresolved question below.

### L6. Documentation precision

- `docs/mcp-api.md` ("A command the runner stopped (timeout, output bound) reports `exitCode: null` and `signal: "SIGKILL"`") does not cover one case. A timeout that fires during `create` returns `signal: null` with empty output (`toolbox-runner.ts:189`). Say "`signal` is `SIGKILL` when the command had started".
- AGENTS.md asks for user-facing guidance in `docs-site/` (for example `docs-site/troubleshooting.md` or `docs-site/ai-tools/`). Only the generated reference, the env table, limits and the security-model bullet were updated. There is no troubleshooting entry for toolbox `FORBIDDEN`, `LIMIT_EXCEEDED` or `UNAVAILABLE`.

## Edge cases checked and found sound

- Abort before the call: rejected with `CANCELLED` before any spawn (`:173`).
- Abort or timeout during create: the container is removed in `finally`.
- Abort during attach: `rm -f`, then `kill`, then `CANCELLED`.
- Output bound: the container is stopped and the result reports `SIGKILL` and `truncated`.
- Spawn `error`: rejects `UNAVAILABLE` and still removes the container in `finally`.
- Async settle does not overwrite a `cancelled` handle (`:2159-2162`).
- The workspace close path does not touch workspace-less toolbox handles.
- The generic-handle 500 cap cannot leak a toolbox slot.
- The sweep runs even when `PACKAGES_ENABLED` is later turned off, which is desirable.

## Recommended actions

1. Fix the test fake's write and close ordering (M1), and change the uninspectable-start fallback to `UNAVAILABLE` (L1). Together they remove the flake and the remaining misreport.
2. Snapshot the timeout at `close` (L2), and make the sweep tolerate per-container failures (L4).
3. Bound the cancel wait, or document it (L3). Add docs-site troubleshooting lines (L6).

## Unresolved questions

- Is a single runner-wide toolbox pool, shared across principals, acceptable for `cloudflare-access` deployments in P1 (L5)?

Status: DONE_WITH_CONCERNS
Summary: All earlier High, Medium and listed Low findings are verified fixed. Owner scoping is strict and does not break any existing workspace-handle path, the sweep is limited to this instance's labels, and hardening parity holds. One new unit test is flaky (1 of 3 parallel runs). It exposes a wrong exit-code fallback, alongside several low-severity races.
Concerns/Blockers: Fix the flaky `toolbox-runner.test.ts` start-refusal test before merge. It can fail CI on the branch that gates the production deploy.
