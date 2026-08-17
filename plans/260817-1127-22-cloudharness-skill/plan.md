---
title: "Cloudharness agent skill"
description: "Issue #22: a contract-driven project skill for safe Cloud Harness MCP coding workflows."
status: completed
priority: P2
effort: "3h"
issue: 22
branch: feat/cloudharness-skill
tags: [skills, mcp, documentation, contract]
blockedBy: []
blocks: []
created: 2026-08-17
---

# Cloudharness agent skill

## Outcome

Give supported AI clients a reusable project-local `cloudharness` skill that
drives the current Cloud Harness MCP surface safely and detects documentation
drift in the normal test suite.

## Scope

- Create `.agents/skills/cloudharness/SKILL.md` and concise references for
  normal use, recovery, security, and the canonical tool inventory.
- Add a contract test that rejects duplicate, missing, extra, or stale skill
  tool names across `RunnerOperationSchema`, `TOOL_SPECS`, the marked
  inventory, and typed marked examples.
- Link the skill from the README navigation.

## Non-goals

- No MCP runtime, schema, isolation, deployment, credential, or Docker changes.
- No claims that planned durable artifacts/tasks or multi-principal context are
  available today.

## Phases

| # | Phase | Status |
| --- | --- | --- |
| 1 | [Create and verify the skill](./phase-01-create-and-verify-cloudharness-skill.md) | Completed |

## Acceptance criteria

- [x] A new agent can follow the normal workflow using the skill and versioned
  public contract.
- [x] Examples cover idempotency, cursors/truncation, patch conflicts,
  lifecycle, recovery, and cleanup without secrets or private identifiers.
- [x] CI fails when documented tool names differ from the public schemas.
- [x] Marked sample inputs also parse through their current public tool schemas.
- [x] The skill preserves the single-owner security and executor-isolation model.
