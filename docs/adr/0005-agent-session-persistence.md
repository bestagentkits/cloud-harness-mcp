# ADR 0005: Agent Session Persistence and Opt-in Durable Runtime

- **Status:** Proposed
- **Date:** 2026-10-19
- **Related Issues:** Issue #396. It builds on the managed-agent runtime and does
  not relax [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md); the
  executor restrictions and the runner-only authority described in the
  [security model](../security-model.md) stay as they are.

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
between "stay as is", "persist the conversation", and "adopt Pi Durable" needs
measured evidence about the current runtime first, which this ADR sets up.

## Current lifecycle and state owners

| State | Owner today | Lifetime |
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
- The worker mints a random request id for every proxy tool call. A repeated
  call is therefore not recognisable as a repeat. The runner answers a duplicate
  request whose effect is no longer in `INTENT` with a generic replayed notice,
  not the original result.
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

The harness measures the shipped `pi-coding` runtime on each of these. In
scenarios 3 and 4 it records the observed outcome of the current runtime
(context lost, work replayed from the start) rather than a failure, so later
options can be compared against it with the same fixtures. Scenario 5 runs the
agent worker for the parent and its children and checks per-agent cleanup; the
runner's lineage handling is covered by the runner tests, not by this harness.

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
| Mid-run crash recovery (use case 4) | No | No resumption; replay-safe reads and a reported unknown effect | Resumes pending tasks; unsafe tools get an interrupted result |
| Change to default behaviour | None | None when the flag is off | None when the flag is off |
| New third-party code in the trusted runner | None | None | Storage code, only when enabled |
| Upstream stability | Pinned, current | Pinned, current | Experimental upstream, breaking minors |
| Pi upgrade required | No | No | Needs the Pi 1.x model layer in a separate package |
| New runner state | None | Message log and receipts | Per-lineage journal database |
| Rollback | Not applicable | Flag off; data left to retention cleanup | Flag off; data left to retention cleanup |
| Migration impact | None | One additive runner schema step, additive API fields | Additive schema step, a second runtime package in the image |

The matrix states what each option is expected to provide by design. Which one
is recommended is decided only after the results section below is filled in.

## Decision criteria

An option is accepted for a use case only when the measured numbers meet these
thresholds. They are proposed here before any option is measured so that the
results cannot move them; the owner can change them while the status is
`Proposed`.

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

The offline numbers measure runtime overhead only. They say nothing about model
quality, latency of real providers or token cost, which only the live run can
show.

## Results

Not yet measured. The offline baseline can be reproduced with
`npm run bench:agent-runtime` (see [development](../development.md#agent-runtime-benchmark)).
The comparison between the options, the live run, and the final recommendation
are added here when the options have been implemented and measured; no number
is recorded in this document before then.

| Measure | 1. Keep Pi | 2. Persistent sessions | 3. Pi Durable |
| --- | --- | --- | --- |
| Offline p50 / p95 wall time, scenarios 1-5 | pending | pending | pending |
| Offline protocol bytes, scenarios 1-5 | pending | pending | pending |
| Duplicate effects after kill and restart | pending | pending | pending |
| Continuation context retained (scenario 3) | pending | pending | pending |
| RSS delta p50 / p95 | pending | pending | pending |
| Live run (small, cost-capped) | pending | pending | pending |

## Consequences

- The harness is runtime-pluggable. Adding an option means implementing one
  `RuntimeUnderTest` and registering it; scenarios, fixtures, repetition count
  and report shape do not change.
- Measuring before choosing keeps the default runtime untouched while the
  options are built behind flags.
- The offline harness uses the real worker, broker and Pi session with a
  scripted faux model. It does not exercise the runner, containers or the
  gateway, so it cannot show launcher cost or network effects.
