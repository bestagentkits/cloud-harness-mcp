# Plan Red-Team Adjudication

Date: 2026-08-16

Three independent reviewers produced 27 raw findings. Duplicate findings were consolidated below. Evidence refers to the plan and the two research reports in this directory.

## Accepted findings

1. **Trusted Git metadata execution (Critical).** No trusted runner process may consume executor-writable Git configuration; clone, Git operations, and result collection now occur in socket-free containers with isolated Git configuration.
2. **Clone outside resource containment (High).** Clone/checkout now uses a fixed resource-limited helper container, a `CREATING` record, temporary materialization, and three-inventory reconciliation.
3. **Clone SSRF/config inheritance (High).** The plan now denies unsafe redirects/proxies/addresses and disables system Git configuration, hooks, filters, LFS, and submodules during materialization.
4. **Soft disk ceiling overstated (Critical).** The plan no longer claims a hard disk quota. It documents one-workspace admission, reserve-floor admission, the race, and the quota-backed-storage requirement before hostile use.
5. **Lost create/launch responses (High).** Workspace/task/shell creation now has idempotency keys plus owner-scoped list/status recovery.
6. **Ambiguous disconnect semantics (High).** Synchronous exec is request-owned; detached tasks/shells are workspace-owned; close/TTL kills the container and descendants.
7. **Competing cleanup authorities (High).** The runner is the only reaper and uses leases plus generation-fenced state transitions.
8. **Crash during creation (High).** A durable `CREATING` record precedes materialization; temporary paths, guaranteed credential cleanup, and DB/path/container reconciliation are required.
9. **Unsafe state rollback (Critical).** The plan now requires schema compatibility checks, quiesced backups, state manifests, and refusal of incompatible downgrade.
10. **Unsafe promotion/first install (High).** Full canary and cleanup precede promotion; first-install failure has route-disable/uninstall restoration independent of a prior image.
11. **Executor egress ambiguity (High).** `none` is default; an explicit owner-only `bridge` profile supports dependency installation and is documented as weaker.

## Rejected or scope-bounded findings

1. **Reduce to seven tools.** Rejected because files, grep, exec, sessions, tasks, Git, worktrees, skills, hooks, and memories are explicit user requirements. The plan instead centralizes shared policy and tests capability equivalence.
2. **Remove raw Docker authority entirely.** Rejected as an MVP blocker: the accepted design intentionally uses a trusted private runner with rootful Docker and explicitly excludes hostile multi-tenancy. The runner remains internal, fixed-policy, and is the only socket holder; stronger isolation is a documented future requirement.
3. **Replace the bearer with a general token issuer/mTLS.** Rejected for the private single-owner MVP. The implementation must support high-entropy secret-file loading, constant-time validation, no logging, atomic rotation, and incident-response documentation; general OAuth remains a non-goal.

## Conditional findings

- GitHub App cloning is optional. Contract, broker, and credential-leak tests are mandatory; live private-repository verification is conditional on owner-supplied App credentials and may not be claimed otherwise.
- Codex CLI configuration and the official MCP SDK client are documented. The official client is the live conformance target; additional clients are not claimed without evidence.
