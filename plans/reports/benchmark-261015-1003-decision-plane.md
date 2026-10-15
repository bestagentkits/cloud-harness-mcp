# Decision Plane benchmark — live run, 2026-10-15

Provider: TypeSafe Jev (`jev-latest`, served `jev-1.13.0`). Harness:
`test/benchmarks/decision-plane.bench.test.ts`, fixtures in
`test/fixtures/decision-plane/`. Raw output:
`plans/261015-0946-217-decision-plane/benchmark-live.json`. The key was read from
the environment and never printed.

| Measure | Deterministic | Decision Plane |
| --- | --- | --- |
| MCP routing top-1 (16 queries) | 0.688 | 1.000 |
| MCP routing top-3 | 0.875 | 1.000 |
| Rerank applied | — | 15/16 (one query had a single lexical candidate and was not sent) |
| Generic failures left unnamed (11 cases) | 1.000 | 0.182 |
| Correct kind on the 10 nameable failures | — | 0.900 (the flaky case abstained at 0.40 confidence → `unknown`) |
| Latency p50 / p95, routing | — | 101 ms / 294 ms |
| Latency p50 / p95, failure classification | — | 100 ms / 120 ms |
| Fallback rate (live) | — | 0 |
| Fallback rate, unreachable endpoint (offline suite) | — | 1.0, lexical order kept |
| Denied tool ever ranked | — | never (asserted on every case) |

Tokens: routing 10,891 in / 3,938 out over 15 calls; classification 7,631 in /
2,096 out over 11 calls.

Caveats: the fixtures are small and hand-written, so they show that the
mechanism works and stays safe. They do not show how it generalizes. An
earlier run in the same session showed the routing p95 at 418 ms, which is
within the 1,500 ms call bound.
