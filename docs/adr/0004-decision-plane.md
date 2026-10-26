# ADR 0004: Advisory Decision Plane for Semantic Routing and Failure Diagnosis

- **Status:** Accepted
- **Date:** 2026-10-15
- **Related Issues:** Issue #217 (this feature). It builds on the existing
  TypeSafe skill suggester and does not relax
  [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md).

## Context

The harness makes many small semantic choices with hand-written rules: lexical
search ranking for MCP gateway tools, and regex classification of GitHub CLI
failures. Rules are predictable but brittle. A query that describes a tool in
different words ranks the right tool low. A failure that matches no rule comes
back as the generic `GITHUB_ACTION_FAILED`, which tells the caller nothing about
whether a retry, a credential refresh, or a human is needed.

A typed semantic model such as TypeSafe Jev answers bounded questions (pick one
option, yes/no, a score) with calibrated probabilities in a few hundred
milliseconds. Sending harness state to a third party, though, is a new egress
path for workspace output, and a model must never become an authority that
grants access.

## Decision

Add a provider-neutral **Decision Plane** in the runner. A caller submits
redacted state and typed questions for one *purpose*, and gets typed answers
with confidence back, or a deterministic fallback.

### It advises and never authorizes

- Deterministic policy runs first and stays the authority. The MCP gateway
  removes denied and disabled tools *before* ranking. The plane may only reorder
  the lexical pool it was offered, and the API rejects any ordering that is not
  an exact permutation of that pool.
- The GitHub classifier keeps its `code` and `retryable`. A diagnosis is added
  as `data.diagnosis` (always `advisory: true`), and only when the classifier
  fell through to its generic code.
- Every failure path (purpose off, no key, redaction failure, timeout, caller
  cancellation, rate limit, HTTP error, malformed or out-of-range answer, low
  confidence) returns
  the deterministic result. The plane never throws into its caller.

### It is off until the owner opts in twice

`DECISION_PLANE_PURPOSES` enables purposes instance-wide and defaults to empty.
`TYPESAFE_EGRESS=off` closes every purpose regardless, because the plane shares
the TypeSafe key and endpoint with the skill suggester.
A call is also made only for an owner who has stored a TypeSafe integration key,
which is the same key the skill suggester uses. Only implemented purposes are
accepted. The purposes reserved in the contract for later phases (supervision,
risk, context selection, test selection) are rejected by configuration.

### Credentials and data stay in the runner

The provider key is decrypted in the runner, which already holds integration
credentials. The API only calls the internal `decision_rerank_tools` operation
and receives an ordering. State is redacted fail-closed before it is sent: the
workspace secret snapshot, model-provider credentials, the provider key itself,
and the transient GitHub token are removed together with known credential
shapes. Text is redacted whole before it is shortened, so a cut cannot split a
secret into a fragment no rule recognises. If redaction fails, nothing is sent. Request bodies, timeouts, and
per-owner call rate are bounded in the code.

### Decisions are observable without recording content

Each evaluation writes one `decision.evaluated` audit row with scalar fields
only: purpose, provider, model, outcome, fallback reason, selection, confidence,
policy effect, latency, sizes, and tokens. Prompts and answers are never
persisted. In-memory metrics per purpose (fallback rate, latency p50/p95, low
confidence, tokens) are served at `GET /api/v1/decision-plane/status`.

## Evidence

The benchmark harness `test/benchmarks/decision-plane.bench.test.ts` uses golden
fixtures in `test/fixtures/decision-plane/`. Its offline suite always runs, and
`npm run bench:decision-plane` adds the live provider when `TYPESAFE_API_KEY` is
set. The live run recorded on 2026-10-15 against `jev-1.13.0`:

| Measure | Deterministic | With Decision Plane |
| --- | --- | --- |
| Routing top-1 (16 queries) | 68.8% | 100% |
| Routing top-3 | 87.5% | 100% |
| Generic-fallback failures left unnamed (11 cases) | 100% | 18.2% (one is genuinely unknown, one abstained below confidence) |
| Correct kind on nameable failures | — | 90% |
| Latency p50 / p95 | — | ~100 ms / ~300 ms |

The fixtures are small and hand-written. They show that the mechanism works and
stays safe, not how well it generalizes. An unreachable provider falls back on
every call; that path is checked offline.

## Consequences

- Owners who opt in send redacted query text and failure output tails to the
  TypeSafe endpoint. That egress is documented in the
  [security model](../security-model.md#decision-plane).
- A search is slower by one bounded provider call. The gateway still answers
  lexically when the plane is off, slow, or wrong.
- Later purposes from issue #217 (agent supervision, risk gating, context and
  test selection) reuse the same interface, fallback, and audit shape. Each one
  needs its own implementation and benchmark before it is accepted in
  configuration.

## Amendment: execution risk (2026-10-19)

`execution-risk` is the third accepted purpose (issues #333 and #417). It is the
`DecisionAdvisor` of the agent policy gate
([ADR 0006](0006-policy-governed-coding-agents.md)) and follows every rule
above: it advises only, and a failure is a deterministic fallback, never a
pass. It is consulted only when a coding run's broker executes an
`advisor_or_approval` action that passed every deterministic check; the
provider then receives the redacted typed summary listed in the
[security model](../security-model.md#decision-plane) (counts, flags, a command
category, the package ecosystem from a fixed list, and an unsalted truncated
SHA-256 digest of the argv), never paths, arguments, names or agent text. Two
things differ from the first two purposes:

- **A third opt-in.** Besides the purpose list and the owner's key, the global
  agent policy must enable the advisor. The policy also holds the risk
  threshold, the confidence floor and whether a failure falls back to approval
  or to deny, so simulation and execution read the same setting.
- **Its fallback can be stricter than the deterministic result.** Without the
  advisor the gate sends an `advisor_or_approval` action to a human, so every
  failure does the same, or denies the action if the owner chose that. The
  provider sees only a typed summary of the action, with no path, argument or
  name.

The offline benchmark replays `test/fixtures/decision-plane/execution-risk.json`
and checks that an undecided provider never clears an action. The live run
reports agreement with the owner's expected outcome and the count of missed
escalations; no live numbers are recorded yet.
