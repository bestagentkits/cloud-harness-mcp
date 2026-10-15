# Decision Plane foundation (issue #217, first slice)

Status: in review · Branch: `claude/determined-gates-b13d4w` → PR into `dev`

## Outcome

A provider-neutral Decision Plane in the runner, with a TypeSafe Jev provider behind
an operator feature flag, two advisory integrations, metadata-only traces and
metrics, deterministic fallback on every path, and an offline/live benchmark.

## Scope (issue "Acceptance criteria for the first implementation")

1. Provider-neutral contracts: `packages/contracts/src/decision-plane.ts`.
2. Jev provider: `apps/runner/src/decision-plane/jev-provider.ts` (reuses TypeSafe
   endpoint allowlist, fail-closed redaction, wire shape verified live).
3. Trace + metrics: one `decision.evaluated` audit row per evaluation (scalars only),
   in-memory latency p50/p95, fallback/low-confidence counts, token usage, exposed by
   the `decision_plane_status` metadata operation.
4. Failure classification: `GITHUB_ACTION_FAILED` (the generic fallback of the
   deterministic classifier) gains an advisory `data.diagnosis`; `code` and
   `retryable` stay deterministic.
5. MCP semantic rerank: gateway `search` keeps lexical candidate generation over the
   permission-filtered catalog, then asks the runner to reorder the candidate pool.
   The API accepts only a permutation of the pool; anything else falls back.
6. Fallback: flag off, no TypeSafe credential, timeout, upstream error, invalid
   answer, rate limit → exact current behaviour.
7. Benchmark: `test/benchmarks/decision-plane.bench.test.ts` with repo-owned golden
   fixtures; live mode opt-in via `RUN_DECISION_PLANE_BENCHMARK=true`.

## Constraints / non-goals

- Never widens permissions; never overrides a deterministic classification.
- Default off (`DECISION_PLANE_PURPOSES` empty) until the benchmark evidence is
  accepted. Phases 2–5 of the issue (supervision, risk, context, test selection) are tracked in #333 as
  follow-ups.

## Validation

Focused unit tests for plane, provider, router, failure intelligence, gateway search;
`npm run verify`; live benchmark evidence in `plans/reports/`.
