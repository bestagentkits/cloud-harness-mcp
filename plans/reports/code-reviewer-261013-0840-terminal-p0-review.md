# Code Review: Dashboard Terminal (#312) and Approvals grant status (#313)

Range: `204a983..HEAD` on `claude/determined-gates-scf47h`. HEAD moved while the review ran. Two commits landed and are included: 4a3eb48 (runner abort test) and 7e0c848 (docs).

## Scope
- Runner: `apps/runner/src/docker-pty.ts`, `operation-manager.ts` (terminal mode), `workspace-service.ts` (`terminal_*` dispatch), `app.ts` (abort wiring), and config.
- Contract: `packages/contracts/src/terminal-schemas.ts`, `internal-runner-api.ts`.
- API: `apps/api/src/dashboard-terminal-router.ts`, `dashboard-response.ts`, `dashboard-assets.ts`.
- UI: `apps/api/dashboard/dashboard-terminal.js`, `dashboard-render.js`, `dashboard.js`, `dashboard.css`.
- Tests: the runner and API unit tests, plus the real-Docker PTY test.
- Commit 68cf4d7 (#313).

## Verification run
- Ran `vitest` on 12 files: the terminal-manager, terminal-dispatch, terminal-router, terminal UI, activity and ui-contract suites. All 206 tests pass.
- `npm run typecheck` passes.
- `eslint` on the changed files is clean. The repo-wide `npm run lint` fails with 674 errors. All of them come from a stray `.claude/worktrees/agent-*` checkout, not from this diff.
- Empirical Docker probe on Docker 29.8.2 with a hardened throwaway container, removed afterwards:
  1. Created a `Tty:true` exec with an `Upgrade: tcp` start.
  2. Ran `sleep 300 &`.
  3. Ended and destroyed the hijacked socket.
  4. Result: `/bin/bash -i` and `sleep 300` were still alive 13 s later, and the exec still reported `Running: true`.
  5. Conclusion: closing the attach stream does NOT hang up the PTY.

## Findings

### High
**H1. A running terminal does not keep its workspace alive. Under the default lease, terminals die mid-use, and the expiry times the UI shows are wrong.** (verified from code)
- Where it happens:
  - `apps/runner/src/workspace-service.ts:4256-4259`: `terminal_read` does not call `touch`.
  - `workspace-service.ts:611-613`: lease expiry.
  - `workspace-service.ts:4512-4524`: the reaper removes the container at `expiresAt`.
  - `operation-manager.ts` `terminalView`: `idleExpiresAt`/`hardExpiresAt` are computed only from the terminal limits.
- The mismatch:
  - Workspace lease defaults: `WORKSPACE_IDLE_TTL_SECONDS=300`, `wallTtlSeconds=900`.
  - Terminal defaults: idle 900 s, which reads also reset; lifetime 8 h.
  - Only `terminal_input` and `terminal_resize` touch the workspace. Running terminals are not counted as active work, unlike tasks, which hold the mutation lock (`workspace-service.ts:294`).
- Failure scenario:
  1. The operator types `npm test` (6 min) and watches without typing.
  2. At 5 min the reaper expires the workspace and removes the executor.
  3. The terminal ends as `failed: workspace executor stopped`. The UI then loops on 410 (see M1).
  4. Throughout, the UI showed "idle expiry" 15 min away.
- Fix options (product choice):
  - (a) While a terminal is running, `touch` the workspace on reads, rate-limited to about one write per 30 s.
  - (b) Have running terminals refresh the workspace mutation lock, the way `onTaskStart` does.
- Either way, clamp `idleExpiresAt`/`hardExpiresAt` to the workspace `expiresAt`/`hardExpiresAt` so the UI tells the truth.

### Medium
**M1. The dashboard retries forever when the workspace is closed, expired, reaping or quarantined.** (verified)
- Where it happens:
  - `apps/api/dashboard/dashboard-terminal.js:127-135` treats only 404 as lost and 401 as fatal. Every other status retries with backoff, without limit.
  - `requireWorkspace` (`workspace-service.ts:1375-1385`) returns:
    - 410 `EXPIRED` for CLOSED or EXPIRED_RECOVERABLE.
    - 409 for REAPING or CREATING.
    - 503 `DEPENDENCY_EGRESS_UNAVAILABLE` for quarantine.
  - The workspace check runs before the terminal lookup, so `closeRecord` → `stopWorkspaceTerminals` never shows up as 404.
- Failure scenario: the workspace is closed from another tab, or expires (H1). The pane stays "Running · Output connection interrupted. Retrying in 15 s." indefinitely, polling the API and runner.
- Fix: treat 410 like 404 (lost, perhaps with a workspace-ended message). Stop after N failures on 409/400/403. Add tests for 410 and 409.

**M2. Session cleanup relies only on `killSession`; its failures are swallowed and never retried.** (verified empirically and from code)
- The false assumption:
  - `docker-pty.ts:35` ("closing the attached stream gives the session a PTY hangup (SIGHUP)") is false; the probe above disproves it.
  - The comment at `docker-pty.ts:169` ("so the daemon tears the attach down") does not tear down the process either.
- The swallowed failures, in `operation-manager.ts`:
  - The idle timer (`armIdleTimer`, around line 1073).
  - The lifetime timer (line 1213).
  - The stream-end path (`settleTerminalStream`, around line 1129).
  - Each calls `cleanTerminalSession(...).catch(() => undefined)` and never retries.
  - Separately, the `inspect` catch at line 1148 sets `sessionCleaned = true` without killing anything. If inspect fails transiently, for example during a dockerd restart with live-restore or a 10 s Engine timeout under load, the shell survives.
- Failure scenario:
  1. A runaway job exhausts `--pids-limit 256`, so `docker exec` for the kill script cannot start.
  2. The idle or lifetime timer fires, and the terminal shows `timed_out`.
  3. Its whole process tree keeps running in the executor until the workspace closes.
  4. After 10 min the record is pruned and nothing tracks it any more.
- Not affected:
  - A runner restart is covered: startup `docker restart`s every surviving executor (`workspace-service.ts:447`).
  - `closeTerminal` surfaces the error to the caller.
- Fix:
  - Retry `cleanTerminalSession` with backoff while the workspace is active.
  - Do not prune a record while `!sessionCleaned`.
  - Correct both comments.
  - Add a Docker test that closes only the connection and asserts the processes survive, so the reliance on `killSession` is documented by a test.

**M3. The redactor holdback makes interactive echo lag when the bytes match a secret prefix.** (verified from code and test)
- Where it happens: `operation-manager.ts` `appendTerminalOutput` uses `StreamRedactor`, which withholds any trailing bytes that match a secret prefix until the next byte arrives (`output-redactor.ts:96-104`).
- `terminal-manager.test.ts:343-355` codifies this: the trailing `tok-s3` only becomes readable after close.
- Failure scenario: with `GH_TOKEN=ghp_...` (the documented runtime secret) injected, typing `g` at the prompt shows nothing until the next key. Typing `gh` and pausing shows nothing. Any prompt or output ending in a secret prefix stalls on screen.
- Trade-off: releasing the holdback on a timer lets a client reassemble a secret from consecutive pages. That conflicts with the security-model claim that injected values are never sent.
- Options:
  - (a) Accept the lag and document it.
  - (b) Use a short idle flush only when the held prefix is shorter than K bytes, and accept partial-prefix exposure.
  - (c) Leave it as is but redact on the read side over a sliding window instead.
- This needs an owner decision.

**M4. Output retention is bounded by bytes, not by chunk count. Trimming is O(n) per chunk, and output has no backpressure.** (speculative on magnitude)
- Where it happens: `operation-manager.ts:108-123` `TerminalOutput.append` stores each socket chunk as its own Buffer and trims with `Array.shift()`.
- Small writes (interactive echo, or `while :; do printf x; sleep .001; done`) can fill the 1 MiB window with hundreds of thousands of tiny Buffers. That means:
  - Large per-object heap overhead per terminal.
  - Each further chunk triggers an O(n) `shift`.
  - Each `read` walks the array linearly.
- A flood (`yes`) runs the per-byte JS Aho-Corasick loop and wakes every reader for each chunk on the runner's single event loop, which every workspace and the API depend on.
- Fix:
  - Use a fixed `Buffer.allocUnsafe(capacity)` ring with head/length indexes and copy-on-append, so there is O(1) trim and one allocation.
  - Optionally `socket.pause()` when the unread backlog exceeds the window, to give real PTY backpressure.

### Low
- **L1.** If `transport.open` fails after the exec was created (the start handshake times out at `docker-pty.ts` start), the catch in `openTerminal` (operation-manager.ts around line 1200) only deletes the record. The exec may still run. Fix: best-effort `killSession` in the catch.
- **L2.** Ended terminals (up to 16 × 1 MiB per workspace) are pruned lazily, only on the next terminal operation, and there is no timer. Expired workspaces never call `stopWorkspaceTerminals`, so their records and buffers stay until some terminal call prunes them.
- **L3.** Output that arrives after `endTerminal` goes through a redaction stream that was already flushed. Its new holdback is never flushed, so trailing bytes can be silently lost. Fix: ignore data when `status !== 'running'`, or flush again on stream end.
- **L4.** `/dashboard/terminals` is headed "Live terminals" but lists ended ones as well (`listTerminals` returns everything retained).
- **L5.** When `readBody` hits the size cap, it rejects with a plain `Error`, not a `HarnessError` (`docker-pty.ts` json → readBody). The caller then gets a generic 500 instead of 503 UNAVAILABLE.
- **L6.** Each input request writes to SQLite through `touch()`, roughly one write per keystroke batch. This is acceptable for a single owner; note it if H1 adds touches on reads.
- **L7.** A replay from the start of a trimmed window can begin mid escape sequence or mid UTF-8 character, which garbles the first line. Cosmetic.
- **L8.** The CSP adapter replaces `document.createElement` for the whole dashboard for the life of the page, and gives every element an own `setAttribute` property. It does not weaken CSP (see below), but it is page-global. It also assumes xterm only uses `.textContent` on style elements; any `.sheet` access in a future xterm would break. xterm is pinned at 6.0.0, so this is acceptable. Neither the adapter nor `mountTerminalPane` has a test.

### Commit 68cf4d7 (#313)
- The change is correct:
  - Statuses match the runner's `PrivilegeGrantStatus` enum.
  - The runner already reports a lapsed PENDING or APPROVED grant as EXPIRED in its list (`state-store.ts:1138`).
  - The badge counts only actionable grants.
  - The `.status.consumed` CSS is added.
- The test covers every state.
- No issues.

## Non-issues verified (threat model applied)
- **Authorization:**
  - `requireTerminal` checks owner and workspace and hides records that are still opening.
  - Each `terminal_*` op calls `requireWorkspace(owner, id)` with `active=true`, which includes the lease or hard expiry check.
  - Open also enforces `enforceActiveLimits` and needs a live container.
  - The BFF builds runner input from path parameters only and refuses any extra body keys (strict schemas).
  - Router-level CSRF covers all POSTs and Origin is checked (`dashboard-router.ts:109-124`). FORBIDDEN maps to 404.
  - Terminal ids are 24 random bytes.
- **PTY identity:** the exec runs as `User: 10001:10001` with `Env` limited to TERM and COLORTERM. Container env is inherited, which matches `shell_*`, so the GH_TOKEN exception is consistent. Payloads are never logged. The pid file is writable by the session user, but that only lets the owner affect their own uid-10001 processes, so it is self-inflicted and out of scope.
- **Abort path:**
  - API: `res.on('close')` → AbortController → undici.
  - Runner: `app.ts` `response.once('close')` → signal → the waiter is removed.
  - Both sides are now tested (`dashboard-terminal-router.test.ts`, and `internal-runner-app.test.ts` in 4a3eb48).
  - Cursor validation rejects anything that is not a safe integer or that is past `end`.
  - `missedBytes = max(requested, start) - requested` is correct.
  - The long-poll is capped below `requestTimeoutMs - 5 s`.
- **XSS:** every runner value in `renderTerminalPanel` and `renderTerminalsIndex` goes through `escape`, `time()` escapes, and status classes are escaped. Terminal output only reaches xterm, never HTML.
- **CSP adapter:**
  - xterm feeds style text only from theme objects and numeric RGB values (`_addStyle` with `color:#hex`, `background-color:#hex`, `a.css`), never from raw escape-sequence text.
  - Injected markup `<style>` or `style=` is still blocked.
  - Injected markup `<ch-cssom-style>` upgrades with an empty sheet, because the parser appends text nodes and never calls the overridden `textContent` setter.
  - Net effect: the CSP is not weakened in practice.
- **Vendor assets:** a fixed map of three resolved files. No request value reaches a path.

## Test-quality gaps
1. There are no `DockerPtyClient` tests against a fake Engine socket for these cases: handshake timeout, non-101 or error response, oversize body, upgrade `head` bytes, socket error mid-stream. The only coverage is the real-Docker happy path.
2. No test proves that close or hangup alone does not end the session. Such a test would have caught the false comment in M2.
3. Nothing tests a `killSession` failure on the idle, lifetime or stream-end paths.
4. Nothing tests the workspace-expiry path (as opposed to `stopWorkspace`) ending terminals, or the UI's reaction to it (410).
5. The redaction test (`terminal-manager.test.ts:343`) asserts the holdback behaviour of M3 as correct.
6. Nothing tests `installCspStyleAdapter` or `mountTerminalPane` against a DOM, for example jsdom or happy-dom.

## Recommended actions
1. H1: decide between the two fixes, then clamp the view expiries to the workspace lease.
2. M1: treat 410 as lost in the UI and stop retrying on 409/400; add tests.
3. M2: retry session cleanup, do not prune records whose session is not cleaned, correct the docker-pty comments, add a Docker test.
4. M4: ring-buffer retention.
5. M3: owner decision on holdback latency versus exposure.
6. Fill the test gaps listed above.

## Unresolved questions
- H1: should terminal reads extend the workspace lease, or should running terminals count as active work like tasks?
- M3: is a visible lag on echoed characters that match a secret prefix acceptable, or should the strict "never sent" redaction guarantee be relaxed for interactive echo?
