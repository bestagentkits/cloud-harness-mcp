# ADR 0006: Agent Session Persistence and Opt-in Durable Runtime

- **Status:** Accepted
- **Date:** 2026-10-19
- **Related Issues:** Issue #396. It builds on the managed-agent runtime and does
  not relax [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md); the
  executor restrictions and the runner-only authority described in the
  [security model](../security-model.md) stay as they are.

## Decision

1. `pi-coding` stays the default engine, and a spawn without `continueFrom` or
   `runtime` behaves exactly as before.
2. Persistent sessions (option 2) ship as an owner opt-in behind
   `AGENT_SESSION_PERSISTENCE_ENABLED`, off by default. They are the recommended
   way to continue an ended agent's work.
3. Pi Durable (option 3) ships as a narrower, experimental opt-in behind
   `AGENT_DURABLE_RUNTIME_ENABLED` and an agent image built with
   `INCLUDE_DURABLE_RUNTIME=true`, both off by default. It is for long tasks
   whose unfinished work should resume after an interruption, not a general
   replacement.

Neither flag becomes a default. Turning on persistence by default would need the
owner exception that criterion 4 requires, and the durable engine fails the
cost-of-ownership comparison against persistence for every measured use case.
The evidence is under [Results](#results).

## Context

A managed agent is one-shot today. The worker ends the Pi session as soon as the
first prompt goes idle, the container is torn down, and the conversation, which
lived only in container memory, is gone. A follow-up to a finished agent is
refused. When the runner restarts, it removes every managed agent container and
moves each non-terminal agent to `INTERRUPTED` with an unknown outcome.

Owners now want two things that this model cannot give:

- continuing earlier work with its context after the agent has finished or the
  process has been restarted;
- surviving a crash in the middle of a model call or tool call without repeating
  side effects.

Pi 0.84.2, the pinned runtime, offers no durable run. `@earendil-works/pi-durable`
1.3.0 does, but it is marked experimental upstream, needs the Pi 1.x model
layer, and would run third-party storage code next to the runner. Choosing
between "stay as is", "persist the conversation", and "adopt Pi Durable" needed
measured evidence about all three, which this ADR records.

## Current lifecycle and state owners

| State | Owner before this decision | Lifetime |
| --- | --- | --- |
| Agent record, status, generation, runner epoch, outcome-unknown flag | Runner principal store (SQLite) | Until compaction or workspace expiry |
| Messages sent to the agent and proxy tool effects | Runner principal store (`agent_messages`, `agent_effects`) | Same as the agent record |
| Usage and spend | Runner principal store and the gateway lease | Lease is RAM-only and never renewed |
| Conversation transcript | Worker process memory (`SessionManager.inMemory`) | One container lifetime |
| Pending tool calls | Worker broker memory, mirrored by an effect row in the runner | One container lifetime |
| Workspace files | Runner-owned workspace | Workspace lifetime |

Facts that shape the options:

- Terminal statuses are set only by the runner's cleanup, and they are
  immutable. The agent protocol (stdin/stdout JSONL) is the only channel into a
  fresh container.
- Before receipts, the worker minted a random request id for every proxy tool
  call, so a repeated call was not recognisable as a repeat.
- After a restart the runner moves undelivered messages and in-doubt effects to
  `UNKNOWN`. It never re-issues them.
- A parent agent id is recorded and used for depth admission. Each agent has its
  own container, lease and cleanup.

## Two different recoveries

These must not be conflated, in the API or in the documentation.

- **Completed-session continuation.** The earlier agent reached a terminal state
  and its transcript up to that point is complete. Continuing means a new agent
  that starts with that transcript as context. No tool call is in doubt.
- **Mid-model or mid-tool crash recovery.** The run stopped while a model
  request or tool call was in flight. Recovering requires knowing whether the
  tool's effect happened, and either replaying only operations that are safe to
  repeat or reporting the effect as unknown. Anything claiming to "restore" such
  a run without receipts would risk duplicate writes.

An `INTERRUPTED` run never reports success under either mechanism.

## Benchmark use cases and minimum recovery requirement

The harness in `test/benchmarks/agent-runtime.bench.test.ts` scripts one
scenario per use case. The requirement is what an option must provide for the
use case to be considered served.

| # | Use case | Minimum recovery requirement |
| --- | --- | --- |
| 1 | Short PR review | None. A fresh run is acceptable; any option must not make it slower or larger by more than the regression budget below. |
| 2 | Multi-step repository task | None for an uninterrupted run. Same regression budget; persistence overhead must be bounded and visible. |
| 3 | Follow-up after a process restart | Continuation: the follow-up starts with the earlier transcript, in a new container, with fresh authorization and budget. |
| 4 | Deliberately killed run with read and write effects | Terminal status `INTERRUPTED`, never success. Completed effects are not repeated; the in-flight effect is reconciled or reported as unknown. Read-only operations may be repeated. |
| 5 | Parent-child cleanup | Every agent's in-flight tool calls are cancelled, every agent reaches a terminal status, and no stored session data outlives its retention. |

## Options

1. **Keep Pi.** `pi-coding` stays one-shot. Follow-up work is a new agent that
   the caller briefs by hand.
2. **Add persistent sessions.** The runner stores the Pi message log, seeds a
   new container with it, and a continuation is a new agent that names its
   predecessor. Proxy operations gain receipts so a replay can be answered
   without repeating an effect. Pi stays at 0.84.2.
3. **Enable Pi Durable for narrow workloads.** Add `pi-durable` as a separately
   packaged, flag-gated runtime that an agent opts into, storing its journal in
   the runner behind a bounded storage protocol.

### Decision matrix

| Criterion | 1. Keep Pi | 2. Persistent sessions | 3. Pi Durable (opt-in) |
| --- | --- | --- | --- |
| Completed-session continuation (use case 3) | No | Yes, new agent with stored transcript | Yes, through its own journal |
| Mid-run crash recovery (use case 4) | No | No resumption; the interrupted call is closed with its settled outcome | Resumes pending tasks; the interrupted call is re-issued, and the ledger refuses a duplicate effect |
| Change to default behaviour | None | None when the flag is off | None when the flag is off |
| New third-party code in the trusted runner | None | None | pi-durable storage code, only when enabled |
| Upstream stability | Pinned, current | Pinned, current | Experimental upstream, breaking minors |
| Pi upgrade required | No | No | Pi 1.x model layer in a separate package |
| New runner state | None | Message log and receipts | Message log, receipts and a per-lineage journal database |
| Rollback | Not applicable | Flag off; data left to retention cleanup | Flag off; data left to retention cleanup |
| Migration impact | None | Additive schema steps v15 and v16, additive API fields | Additive schema step v17, a second runtime package in an opt-in image |

## Decision criteria

These were fixed before any option was measured, so the results could not move
them.

1. **Safety, absolute.** Across all repetitions, duplicate effects after a kill
   and restart are 0, an `INTERRUPTED` run is never reported as success, and a
   leftover stored session after cleanup is 0.
2. **Default path unchanged.** With the feature flags off, `pi-coding` protocol
   bytes per scenario are identical to the baseline, and p95 wall time and first
   record time are within the baseline's own run-to-run spread plus 10%.
3. **Continuation works.** In scenario 3 the follow-up's first model request
   contains every message of the earlier transcript, and the continuation starts
   in a new container with a new lease and budget.
4. **Overhead is bounded.** For an option that persists, added p95 wall time per
   scenario and added protocol bytes per scenario are reported against the
   baseline. An option whose added p95 exceeds 25% of the baseline on scenarios
   1 and 2 needs an explicit owner exception.
5. **Memory is bounded.** The p95 RSS delta per run does not exceed the baseline
   by more than 25%, and stored transcript size stays under the configured
   per-session cap.
6. **Cost of ownership.** The option's new third-party surface, schema changes
   and flags are listed, and each has a documented rollback.

## Results

### Offline

`npm run bench:agent-runtime` with `AGENT_RUNTIME_BENCHMARK_REPS=20`, 20
repetitions per scenario and runtime, Node v24.11.0 on a Windows 11 developer
machine. Every runtime runs the same scripted model steps, prompts, tool grants
and limits from `test/fixtures/agent-runtime/scenarios.json`.

- `pi-coding` is the shipped worker with an in-memory proxy executor and no
  runner.
- `pi-coding+persisted` and `pi-durable` run the image's engine router behind a
  real `AgentManager`, agent state repository and SQLite state store, with an
  in-process launcher whose cleanup waits for the worker like `docker stop`.
  The durable runtime also uses the runner-hosted durable session store over the
  storage protocol.

Wall time and first record are in milliseconds, RSS deltas in KiB, storage is
runner rows written and their bytes.

| Scenario | Runtime | Wall p50 / p95 | First record p50 / p95 | Protocol bytes | Storage rows / bytes | RSS delta p50 / p95 | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 PR review | pi-coding | 5.42 / 10.81 | 2.19 / 3.31 | 3145 | 0 / 0 | 80 / 1584 | succeeded |
| 1 PR review | persisted | 118.11 / 198.59 | 10.95 / 15.33 | 6540 | 11 / 4043 | 1100 / 2656 | succeeded |
| 1 PR review | durable | 89.50 / 128.84 | 12.30 / 20.14 | 33651 | 30 / 21357 | 1716 / 9240 | succeeded |
| 2 Multi-step task | pi-coding | 5.76 / 8.43 | 1.63 / 2.03 | 4588 | 0 / 0 | 64 / 496 | 2 effects |
| 2 Multi-step task | persisted | 131.35 / 169.18 | 10.33 / 28.32 | 10300 | 18 / 6604 | 656 / 2176 | 2 effects |
| 2 Multi-step task | durable | 330.60 / 535.96 | 38.62 / 135.42 | 58276 | 57 / 38112 | 2472 / 5384 | 2 effects |
| 3 Restart follow-up | pi-coding | 6.26 / 7.18 | 1.52 / 1.84 | 3205 | 0 / 0 | 84 / 4124 | context lost |
| 3 Restart follow-up | persisted | 121.48 / 184.59 | 9.41 / 11.30 | 6183 | 16 / 4547 | 1072 / 3804 | continued, all 5 earlier messages |
| 3 Restart follow-up | durable | 277.54 / 494.79 | 40.65 / 63.63 | 37909 | 33 / 20706 | 1676 / 3856 | continued, all 5 earlier messages |
| 4 Killed run | pi-coding | 9.14 / 11.41 | 1.60 / 1.90 | 5287 | 0 / 0 | 128 / 4596 | replayed from start, 1 duplicate effect |
| 4 Killed run | persisted | 112.30 / 180.58 | 10.03 / 15.60 | 6728 | 20 / 6075 | 1028 / 6436 | interrupted, 1 unknown effect, continued, 0 duplicates |
| 4 Killed run | durable | 447.35 / 773.73 | 40.37 / 85.25 | 58339 | 55 / 34490 | 3280 / 5652 | interrupted, 1 unknown effect, continued, 0 duplicates |
| 5 Parent-child cleanup | pi-coding | 19.76 / 30.60 | 3.70 / 4.13 | 1995 | 0 / 0 | 384 / 13008 | 3 of 3 cancelled |
| 5 Parent-child cleanup | persisted | 153.38 / 807.60 | 18.04 / 30.74 | 3642 | 12 / 1611 | 2532 / 19876 | 3 of 3 cancelled |
| 5 Parent-child cleanup | durable | 340.84 / 526.74 | 17.21 / 80.92 | 46961 | 42 / 27269 | 5116 / 7668 | 3 of 3 cancelled |

Every persisted and durable run left 0 session rows, 0 effect rows and 0
lineage databases after cleanup. In scenario 4, every interrupted run ended
`INTERRUPTED` and none was reported as success. A persisted continuation
received the interrupted call's settled outcome and did not issue it again. A
durable continuation re-issued the interrupted call once, because the engine
resumes its pending task; the effect ledger answered it without a second write.
That re-issue is counted as a repeated invocation, not a duplicate effect.

Token counts are left out of the table because the faux providers of Pi 0.84
and Pi 1.3 estimate tokens differently; the context each model request carried
(messages and bytes) is identical across the three runtimes.

### Live

One small run through the real launcher, gateway and provider, recorded to see
container cold start, real model latency and token use. It is a sample, not a
statistically strong comparison.

- **Stack:** a local Compose project on Docker Desktop (Windows 11), built from
  this branch with the durable agent image, both flags on, one
  `network-none` workspace on the `test-fixture-v1` fixture ref.
- **Model:** `beam-free` on OpenCode Go, the cheapest tool-capable entry that
  `model_catalog_search` returned (catalog price 0 USD per million input and
  output tokens). Every agent's recorded cost was 0.
- **Spend:** the run's cap was 5 USD. The runner's spend ledger estimated
  2.00 USD, because a killed run's last model request reports no usage and is
  charged at its 0.25 USD per-agent cap; the provider billed nothing.
- **Matrix:** scenarios 1, 3 and 4, three repetitions each per runtime, 27 runs
  and 45 agents, driven by
  [`live-driver.ts`](../../test/benchmarks/agent-runtime/live-driver.ts).
  Scenario 4 kills the agent's container with `docker kill` after its first
  successful write, then spawns the restart with the same task prompt, as a
  continuation for the persisting runtimes and as a fresh agent for `pi-coding`.

Times are per agent, from `agent_status` and the first `agent_logs` event.
Tokens are medians per agent as reported by the gateway.

| Scenario | Runtime | Succeeded | Cold start p50 / p95 ms | Wall p50 / p95 s | First event p50 / p95 ms | Input / output tokens | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 PR review | pi-coding | 3 of 3 | 719 / 1528 | 59.2 / 61.4 | 3455 / 4782 | 10735 / 5215 | |
| 1 PR review | persisted | 3 of 3 | 519 / 571 | 56.6 / 63.5 | 2691 / 4159 | 13616 / 4834 | |
| 1 PR review | durable | 3 of 3 | 670 / 1004 | 52.3 / 53.0 | 4263 / 6630 | 15997 / 5548 | |
| 3 Restart follow-up | pi-coding | 3 of 3 | 584 / 1495 | 7.8 / 60.6 | 3060 / 4150 | 262 / 112 | not continued; follow-ups re-read the workspace with 6033-12474 input tokens |
| 3 Restart follow-up | persisted | 3 of 3 | 516 / 789 | 7.0 / 7.7 | 2205 / 2549 | 74 / 115 | 3 of 3 continued; follow-ups used 697-1231 input tokens |
| 3 Restart follow-up | durable | 3 of 3 | 548 / 1811 | 9.3 / 12.7 | 3923 / 7210 | 377 / 111 | 3 of 3 continued; follow-ups used 684-1044 input tokens |
| 4 Killed run | pi-coding | 3 of 3 restarts | 557 / 923 | 88.4 / 187.7 | 2566 / 3901 | 21706 / 8394 | 3 of 3 `INTERRUPTED`, none reported success; restarts redid the task with 17612-25778 input tokens |
| 4 Killed run | persisted | 3 of 3 restarts | 538 / 676 | 12.4 / 122.2 | 2172 / 2680 | 1742 / 1569 | 3 of 3 `INTERRUPTED` with outcome unknown, none reported success; 3 of 3 continued with 694-1742 input tokens |
| 4 Killed run | durable | 2 of 3 restarts | 533 / 735 | 64.8 / 191.8 | 3585 / 6079 | 14781 / 5243 | 3 of 3 `INTERRUPTED` with `run.resumable: true`, none reported success; 3 of 3 continued; one restart wrote 65 times and ended `LIMIT_EXCEEDED` on the model budget |

Findings:

- Cold start does not depend on the engine: every runtime started its container
  in about half a second at p50, and the durable image adds no measurable launch
  cost.
- On an uninterrupted task, wall time is the model's. The persisting options
  show no added latency that rises above the variation between runs.
- Continuation is where they differ from `pi-coding`: a continued follow-up or
  restart needed one tenth or less of the input tokens of a fresh agent that had
  to rebuild its context, because it did not redo the work.
- Duplicate effects cannot be counted exactly from outside the runner, because
  the restart repeats the whole task prompt and the model may legitimately write
  the same file again. The effect ledger answers a repeated request ID with its
  receipt, as the offline runs prove.
- One durable restart wrote 65 times in 64 seconds until the gateway's model
  budget stopped it, as designed. The cause is the model, not the engine or the
  runner. A follow-up diagnosis drove the real worker and runner offline,
  including a container killed mid-stream after an applied write. Each tool call
  the model issued became exactly one proxied request under a fresh
  `durable-task-<id>` request ID and one executor call, with a new ledger row.
  Nothing was re-dispatched or answered from a stored receipt. The resumed
  transcript held only completed results, with no interrupted call or aborted
  partial fed back. The engine never reruns an unsafe tool after a restart; it
  settles it as an error, which the benchmark does not count as a write. So 65
  counted writes are 65 distinct model calls that reached the workspace. The
  same free model had already spent 19k output tokens and 191 seconds on this
  three-edit task before the kill, and the other two durable restarts finished
  with three and four writes on the same code path. The gateway budget is the
  control that bounds such a loop. The restart is still the only recovery in
  the matrix that did not complete, and one more reason the durable engine stays
  a narrow opt-in.

### Evaluation against the criteria

1. **Safety.** Both persisting options meet it: offline over 20 repetitions,
   0 duplicate effects and 0 leftovers; offline and live, no interrupted run
   reported as success. `pi-coding` alone repeats the completed write when the
   caller replays the task.
2. **Default path unchanged.** Met. With the flags off the spawn path, start
   record and protocol are those of the baseline, and the offline `pi-coding`
   rows are produced by the unchanged worker.
3. **Continuation.** Met by both persisting options, offline with every earlier
   message in the first request, and live where every follow-up continued its
   predecessor in a new container with its own lease.
4. **Overhead.** Offline, both persisting options add far more than 25% p95 on
   scenarios 1 and 2. Most of it is the in-process runner and SQLite work that
   the runner-less baseline does not do at all, and live the difference is
   inside the noise of real model latency, but by the pre-stated rule neither
   may become the default without an owner exception. Persistence adds 1.4-5.7 KB
   of protocol per scenario; the durable engine adds 30-54 KB.
5. **Memory.** Offline RSS deltas exceed the 25% budget for both options, again
   measured against a baseline without a runner; the durable engine's p95 is the
   highest on scenarios 1 and 2. Stored sessions stayed far below the session
   and lineage caps.
6. **Cost of ownership.** Persistence adds no third-party code. The durable
   engine adds an experimental upstream package, a second Pi model layer in an
   opt-in image, a runner-side storage protocol and a per-lineage database,
   for a resume that the effect ledger must still fence.

## Consequences

- The default stays as it was, so no owner sees a change without opting in.
- Owners who want follow-ups enable persistence. Owners who want interrupted
  long tasks to resume their own pending work can additionally enable the
  durable engine, accepting its upstream risk and larger storage.
- The harness is runtime-pluggable. Adding an option means implementing one
  `RuntimeUnderTest` and registering it; scenarios, fixtures, repetition count
  and report shape do not change.
- The offline harness does not exercise containers or the gateway, so it cannot
  show launcher cost or network effects; the live run does, on a small sample.

## Rollback

- **Kill switch.** Unset `AGENT_SESSION_PERSISTENCE_ENABLED` and
  `AGENT_DURABLE_RUNTIME_ENABLED` and restart the runner. The flags are read
  only at start, so the restart is what applies them, and it stops running
  agents as any restart does: cancelled on a clean stop, `INTERRUPTED` after an
  abrupt one. Afterwards `continueFrom` and durable spawns are refused with
  `NOT_SUPPORTED`, and nothing resumes on its own. The default spawn path never
  reads the stored data.
- **Retention purge.** Stored sessions, receipts and durable lineage databases
  are removed by the retention in `AGENT_SESSION_RETENTION_MS` or when their
  workspace closes; no manual cleanup is needed.
- **Downgrade.** A rollback to a runner older than this decision steps the state
  schema from v17 to v14 with `downgradeStateSchemaToV14` in
  `apps/runner/src/principal-store.ts`, which passes through
  `downgradeStateSchemaToV16` and `downgradeStateSchemaToV15`. Each step refuses
  while durable agents, stored receipt text or persisted sessions exist unless
  data loss is allowed, so the flags go off and retention runs first. Effects
  that kept only hashes, as every effect of an agent spawned without persistence
  or the durable engine does, do not block it. `agent-sessions/` is
  deleted after a downgrade below v17. The steps are in
  [operations](../operations.md#kill-switch-and-rollback).

## Migration impact

- State schema v15 adds persisted sessions, v16 adds effect receipts and lineage
  keys to the effect ledger, and v17 records each agent's engine and whether its
  run left unfinished work. All three are additive and applied on runner start.
- `agent_spawn` gains optional `continueFrom` and `runtime`; `agent_status` and
  `agent_list` gain `session`, `run`, `continuedFrom` and `runtime` only for
  agents spawned with a flag on. Callers that send neither field see no change.
- The default agent image is unchanged. The durable engine ships only in an
  image built with `INCLUDE_DURABLE_RUNTIME=true`.

## Canary

- **Local, done.** The live benchmark above ran on a local Compose stack with
  both flags on and the durable image, through the real launcher, gateway and
  provider, and its stack was torn down afterwards.
- **Production, owner decision.** Enabling either flag on the production
  instance follows the canary in
  [operations](../operations.md#canary): back up state, enable one flag,
  continue and cancel a disposable agent, close its workspace and check that its
  stored data is gone. It is not performed as part of this decision.
