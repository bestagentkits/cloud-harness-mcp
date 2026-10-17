# Code review: `bash` MCP tool (issue #312, P1)

- Worktree: `/workspace/cloud-harness-mcp/.claude/worktrees/agent-ad11303c6983e22ef`
- Range: `39d00a0..2460ea8` (46958a4 feat, 2460ea8 docs). 32 files, +872/-24.
- Checks run: focused vitest (7 files, 76 tests pass), runner and api `tsc --noEmit` clean, eslint on touched files clean,
  `verify-docs-reference.mjs` no drift, `plugin:check` byte-identical. Docker suite not run (no executor image locally);
  toolbox kill paths were probed live with `runToolboxCommand` against `node:24-bookworm-slim` (probe containers removed).

## Verdict

The workspace target is a faithful delegation to `exec_run`, and the hardening refactor does not change behaviour. The
toolbox target has one verified cleanup defect: an abort during container startup leaks containers. It also has a
resource-bound gap: the number of concurrent toolbox containers is not capped. Both need a fix before the
`PACKAGES_ENABLED` gate is turned on anywhere. Nothing here is a trust-boundary breach.

## Critical

None.

## High

### H1. An abort during startup leaks toolbox containers (verified)
`apps/runner/src/toolbox-runner.ts:118-128,155-156`
- `stop()` runs `docker rm -f <name>` once (memoized) and then sends SIGTERM to the docker CLI. If the abort or timeout
  fires before the daemon has finished creating the container, `rm -f` reports "No such container". The CLI dies before
  it sends `start`. The daemon then finishes `create`, after the `finally` `rm -f` has already run.
- The result is a container left in the `Created` state. `--rm` never applies, because the container never started.
- Live probe, aborting 0 to 1500 ms after the call: 3 of 7 runs left `chm-toolbox-* Created` behind (aborts at 0, 30
  and 300 ms). The timeout path at 100 to 500 ms leaked 0 of 8 runs, but it uses the same logic.
- The leftovers are reaped only by the startup reconcile (`workspace-service.ts:487-492`, ephemeral label plus instance
  label). They accumulate for the whole life of a runner.
- The docs overclaim here. `docs/mcp-api.md` and `docs/security-model.md` say the container is "removed by exact name
  ... on exit, timeout, or abort".
- Failure scenario: an MCP client with a short API deadline, or one that cancels repeatedly, keeps aborting toolbox calls
  while they start. Dead containers pile up until the next deploy.
- Fix:
  - Split the run into `docker create` (checked) and `docker start -a`, so the container always exists before a stop
    decision.
  - Alternatively, after `close`, retry `rm -f` with a short bounded backoff until `docker inspect` shows the name is
    gone.
  - Add a unit test with a fake `spawn` and a docker test that aborts immediately (before polling for the container) and
    then asserts zero containers with the instance label.

### H2. No cap on concurrent toolbox containers (verified by reading the code)
`apps/runner/src/workspace-service.ts:2112-2138`, `2395`
- Each toolbox call starts a new 1 GiB / 1 CPU / 256-pid container.
- No limit applies: no semaphore and no per-principal or per-instance limit. The calls are not counted against
  `MAX_ACTIVE_WORKSPACES_PER_OWNER`, and that limit is the number the docs tell operators to size host memory by
  (`docs-site/reference/environment-variables.md`).
- With the runner and API running on the same host, an agent can fan out N parallel `bash {target:"toolbox"}` calls.
  That can oversubscribe memory and pids, and the host OOM killer may then hit control-plane containers.
- In `cloudflare-access` mode every principal shares this unbounded pool.
- Fix: add a runner-level counting semaphore, for example a `TOOLBOX_MAX_CONCURRENT` default of 2, or derive it from the
  workspace limit. Return `LIMIT_EXCEEDED` (429, retryable) when the pool is full, and test it.

## Medium

### M1. Docker daemon failures are reported as a successful command exit (verified)
`toolbox-runner.ts:132-152`, `workspace-service.ts:2137`
- Missing image (`--pull never`), a name conflict, or a daemon error makes `docker run` exit with 125, 126 or 127 and
  print `docker: Error response from daemon ...` on stderr. Confirmed: a missing image gives exit 125.
- `runToolbox` returns `ok:true, "Command exited with 125"` and mixes the daemon text into user output. A probe also
  showed `container is marked for removal and cannot be started` appearing in `output` on the timeout race.
- Fix: run `create` and `start` separately (see H1) and map a failed `create` to `UNAVAILABLE` (retryable). At minimum,
  treat exit 125 with an empty-or-`docker:` prefix as `UNAVAILABLE`.

### M2. The toolbox target cannot honour the ADR "long command returns a handle" rule
- References: `tool-schemas.ts` superRefine (async forbidden for toolbox) and ADR 0003, "`bash` MCP tool".
- `timeoutMs` allows up to 300 s, but the API runner client aborts at `requestTimeoutMs` (default 60 s,
  `packages/contracts/src/config.ts:147`).
- Failure scenario: a 120 s toolbox command is cancelled by the API deadline, and the caller gets a transport timeout
  with no partial output instead of `TIMEOUT` plus output.
- Fix: either cap the toolbox `timeoutMs` below the API deadline and document it, or support `async` through the generic
  operation manager with no `workspaceId`. If neither is done in P1, record the deviation in the ADR.

### M3. No in-container deadline, so orphaned running toolbox containers outlive the runner (speculative or partial)
`toolbox-runner.ts:94`
- If the runner crashes or is SIGKILLed mid-call, the attached CLI dies but the container keeps running until its
  command exits. `sleep infinity` would run forever.
- Startup reconcile reaps it on the next start (verified, labels match). The periodic reaper does not.
- If the runner stays down, or its state DB (and so its `instanceId`) is reset, the container is never reaped.
- Separately, my probe showed that SIGTERM to an attached `docker run` CLI is proxied to the container and the CLI stays
  attached. With the executor image's `tini` this ends a normal command. A command that traps TERM combined with the H1
  race could hang the request (not reproduced).
- Fix:
  - Wrap the command in an in-container deadline, for example
    `/usr/bin/timeout -k 5 <ceil(timeoutMs/1000)+5> /bin/bash -c ...`.
  - Have the periodic reaper remove `cloud-harness.role=toolbox` containers older than the maximum timeout plus a margin.

## Low

- **L1** (`workspace-service.ts:2137`): `Command exited with ${exitCode ?? 1}` says "1" when the CLI was killed by a
  signal (truncation path). Report the signal instead, or use `exitCode ?? 'signal'`.
- **L2** (`toolbox-runner.ts:20,94`): the shell environment differs from the workspace target.
  - The workspace target uses `bash -lc` (`worker/harness-worker.mjs:1186`), which sources
    `/etc/profile.d/harness.sh` and puts `/opt/harness/bin` (the `npx` dispatcher, `skills`, `skillx`) first on PATH.
  - The toolbox uses `bash -c` with `TOOLBOX_PATH`, which omits `/opt/harness/bin`. The docstring "PATH matching the
    executor's" is therefore misleading.
  - Either add `/opt/harness/bin` or document the difference.
- **L3**: the toolbox `output` decodes a byte-truncated buffer with `toString('utf8')`. A multibyte split can make the
  output slightly longer than `maxOutputBytes` once re-encoded. `exec_run` shares this behaviour, so this is cosmetic.
- **L4**: a NUL byte in `command` makes `spawn` throw a raw `TypeError` inside the Promise executor. That surfaces as
  `INTERNAL_ERROR` rather than `INVALID_INPUT`. Reject `\0` in the schema, or wrap the spawn.
- **L5**: the result of an async workspace `bash` read through `operation_status` or `operation_wait` has no `target`
  (the operation kind is `exec_run`). That contradicts the docs, which say the result is "`exec_run` envelope plus
  `data.target`". Either document it or add the target.
- **L6**: `docs-site/reference/environment-variables.md` also gained four `TERMINAL_*` rows. These come from
  regenerating from `.env.example`, are harmless and correct, but are outside the slice. Mention them in the PR.

## Focus-area answers

1. **Workspace target.**
   - It goes through the same `requireWorkspace` and lease path, the `maxOutputBytes` clamp,
     `handleExecRun`/`runWorker` (redaction, worker timeout) and `enforceActiveLimits`. The async handle and mutation
     lock come from `handleExecRun`.
   - `execRunInputFromBash` hard-codes `privileged:false`, and the strict schema rejects `privileged` and
     `approvalGrantToken`, so the approval flow cannot be bypassed.
   - `isMutationOperation` (`workspace-service.ts:4697-4699`) matches unprivileged `exec_run`: a lease when sync, none
     when async, because async uses `setMutationLock`. The toolbox never reaches it.
   - When `workspaceId` is omitted, the call falls through to generic resolution. That is correct, but no runner test
     covers it.
   - No other API or runner allowlist (agent proxy, dashboard) special-cases `exec_run`, so nothing is bypassed.
2. **Toolbox target.**
   - The hardening flags are identical (shared frozen list). It runs `--network none` with no `--volume`, no `--env-file`
     and no socket. Only fixed `--env` values are passed, with no bare `--env NAME` passthrough.
   - Argv injection is not possible: the name and instance are regex-validated, the command is a single argv element
     after `-c`, the image comes from operator config, and mount paths are validated.
   - The `PACKAGES_ENABLED` gate is checked before any spawn, defaults off, and accepts only a strict `true`. Compose
     passes it through `env_file`.
   - Labels work for startup reconcile. The gaps are H1, H2 and M3.
3. **createExecutor refactor.** The token-for-token removal is replaced by `EXECUTOR_HARDENING_ARGS`. Only the position
   of `--workdir` moved, which has no effect. `concurrent-workspaces.test.ts` pins the sequence.
4. **Contract consistency.**
   - Consistent: schema, annotations (same `destructive` as `exec_run`, plus `openWorld`), the generated reference
     (no drift), skill, plugin (identical) and both local backends (toolbox refused with `INVALID_INPUT`).
   - Inconsistent: the abort and exact-name removal claim in the docs (H1), and L5.
5. **Test gaps.**
   - No test aborts or times out before the container exists (H1).
   - No concurrency test (H2).
   - No unit test of `runToolboxCommand` with a fake spawn. The kill paths are covered only in docker CI.
   - The docker test does not assert that `sudo -n true` fails. This matters because the executor image grants
     NOPASSWD sudo, so `no-new-privileges` is the only thing stopping it.
   - The docker test does not assert `CapEff: 0`.
   - No runner test omits `workspaceId`.
   - The privileged-rejection test asserts only `toThrow()` and should assert a ZodError on `privileged`.

## Recommended actions
1. Fix H1 (create, then start -a, plus post-close removal) and add the immediate-abort docker test.
2. Add the toolbox concurrency cap (H2).
3. Map daemon failures to `UNAVAILABLE` (M1).
4. Resolve the toolbox timeout versus API deadline (M2).
5. Add the in-container deadline and the periodic toolbox sweep (M3).
6. Fix the low items and test gaps.

## Unresolved questions
- Is a global (not per-principal) `PACKAGES_ENABLED` acceptable for `cloudflare-access` multi-principal deployments in P1?
- Should the toolbox audit-log lifecycle metadata the way the terminal does?
