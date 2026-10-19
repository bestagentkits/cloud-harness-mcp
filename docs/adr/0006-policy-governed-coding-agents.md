# ADR 0006: Policy-Governed Coding Agents

- **Status:** Accepted
- **Date:** 2026-10-19
- **Related Issues:** Issue #417 (this decision). It keeps the single-owner
  trust model of [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md)
  and the advisory-only rule of [ADR 0004](0004-decision-plane.md).

## Context

Automations already start agent runs from webhooks, but they are hard-limited
to read-only proxy operations. Letting an agent edit, test, publish a branch or
open a pull request needs an answer to one question before every action: is
this action allowed for this owner, on this project, right now? Without a
single answer, each runtime and each caller would grow its own rules, and a
Dashboard preview could say one thing while execution does another.

The answer must also survive hostile input. A webhook body, a repository file
or a prompt can say anything. None of it may choose the principal, the project
or the policy, and none of it may talk the harness out of a hard deny or a
mandatory approval.

## Decision

### One owner-authored policy, two scopes

The owner writes a versioned `ExecutionPolicy`: one global document and,
optionally, one per project. The schemas live in
[`packages/contracts/src/agent-policy-api.ts`](../packages/contracts/src/agent-policy-api.ts).
The global document lists allowed action classes, hard denies, mandatory
approvals, default effects, repository/branch/path/command/package/host scope,
budgets and approval expiry. A project document can only narrow it: remove
classes, add denies or mandatory approvals, shorten lists, lower budgets. A
project may choose the effect of a class only where the owner marked that
class `delegable`.

Narrowing is enforced twice. A save that widens the global policy is refused
with the offending fields (`POLICY_WIDENS`), and the merge ignores any widening
field at evaluation time and reports it as ignored.

Revisions are immutable rows in the runner SQLite. The head moves by
compare-and-swap on the expected version, rollback writes a new revision, and
every write, removal and rollback is audited. A stale version is a conflict
before any policy check. A change that weakens the effective policy needs a
confirmation bound to a digest of the weakening list the owner reviewed (shown
in full), the operation, the global revision, the target head version and the
policy's highest version, so a confirmation cannot be replayed after the policy
moved or was deleted, or for another operation. Simulations are read-only and not audited.
While no global policy is stored, a read-only default applies that allows only
`read`.

### Cloud Harness owns identity

The principal comes from the authenticated owner session or service identity,
and the project is a Cloud Harness project id checked against the metadata
store. Request bodies, webhook payloads and agent output are never a source for
either. The Dashboard routes take scope and project from the path after reading
the body, and the runner channel validates the full request before it runs. A
project policy whose project no longer exists stays readable and removable, but
every action bound to it is denied (`PROJECT_POLICY_ORPHANED`).

### A single pure gate

`evaluateGate` in
[`apps/runner/src/agent-governance/gate-evaluator.ts`](../apps/runner/src/agent-governance/gate-evaluator.ts)
is a pure function of an action descriptor, a frozen policy snapshot and
runtime facts. It returns `ALLOW`, `REQUIRE_APPROVAL` or `DENY` with a reason
code, matched rules, the policy revisions it read and a fingerprint of the
action. The source comment there owns the precedence order: platform
invariants, then runtime facts, then the global hard deny, scope, allowed
classes, project narrowing, mandatory approval, and finally the effective rule.
The first terminal result wins. The descriptor's free-text `reason` is never
read.

`PURE_GATE_EVALUATOR`, a frozen instance of the `GateEvaluator` port, wraps
that function. The Dashboard simulation and the execution entry point
(`AgentPolicyService.evaluate`, which the coding broker will call) both use it,
with the same resolver and the same advisor-availability setting, so a preview
cannot drift from the decision execution starts from. The only difference is
the advisor's answer, which exists only at execution time: a simulation shows
a discretionary action as pending.

### Advisors can only escalate

`advisor_or_approval` is the one discretionary effect. With an advisor
configured the gate returns `REQUIRE_APPROVAL` with `ADVISOR_REQUIRED`, so a
caller that reads only the decision never lets a pending action run. A
`DecisionAdvisor` answers `no_change` or `escalate`, nothing else. Only a valid
`no_change` turns the pending decision into `ALLOW`; a missing, late or
malformed answer counts as `escalate`. `combineAdvisor` never lowers any other
decision, and `decide` combines evaluation and the answer in one call. With no
advisor configured the effect resolves to `REQUIRE_APPROVAL`. An advisor, a
project or prompt text can never override a hard deny or a mandatory approval.

### The orchestrator owns publishing

An agent edits inside its workspace. Publishing a branch and opening a pull
request are separate action classes (`publish_branch`, `open_pr`) that the
harness performs through its action broker after the gate, scoped to the
policy's branch prefixes. The agent never holds the credential that publishes.

### Ports

[`apps/runner/src/agent-governance/ports.ts`](../apps/runner/src/agent-governance/ports.ts)
versions the boundaries later work builds on: `RuntimeAdapter`,
`ExecutionBackend`, `ActionBroker`, `PolicyResolver`, `GateEvaluator`,
`DecisionAdvisor`, `EventStore` and `NotificationAdapter`. This release
implements `PolicyResolver` (`StorePolicyResolver`) and `GateEvaluator`
(`PURE_GATE_EVALUATOR`); the others are interfaces for later work. Each implementation
declares the contract version it serves as a literal type, so an adapter
written against another version fails to compile. A breaking change adds a new
version instead of editing the current one.

### Off by default

`AGENT_POLICIES_ENABLED` defaults to off. While it is off the channel answers
`FEATURE_DISABLED` and the Dashboard shows how to turn it on instead of an
editor. No MCP tool is added.

## Rejected alternatives

- **Per-runtime policy.** Each runtime would encode its own rules, and the
  Dashboard could not preview them truthfully.
- **Project policies that can widen.** A project is a convenience for the same
  owner, not a separate authority. Allowing widening would make the global hard
  deny advisory.
- **Advisor-authorized actions.** A model answer is evidence, not consent. It
  may raise a decision to approval but never grant one.

## Consequences

- Every governed action has one auditable decision with the revisions it used.
- The owner can test a draft against real actions before saving it.
- This release ships the policy store, the evaluator and the simulation; it
  does not enforce anything on a running agent. Enforcement arrives with the
  coding broker and reuses this resolver and evaluator unchanged.
- Command analysis for platform invariants is static and has two outcomes. A
  container runtime or privilege tool in program position denies, because a
  platform deny cannot be approved. The gate analyses argv only and never parses
  shell syntax: shell strings are never analysed; they always require approval.
  Earlier attempts to read a subset of bash kept missing cases bash runs
  differently, so a script string is unanalyzable whatever it contains. A
  command the analysis cannot read exactly needs a mandatory owner approval
  (`PLATFORM_COMMAND_UNANALYZABLE`) that no advisor or project rule lowers, so ordinary commands such as
  `grep -r docker .` stay usable. The analysis does not read files a command
  runs, so the executor's isolation stays the boundary for that indirect
  execution.
- Turning the flag off makes the two policy tables inert. No existing table
  changes.
