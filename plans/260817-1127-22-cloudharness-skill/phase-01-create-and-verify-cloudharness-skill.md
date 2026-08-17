---
phase: 1
title: "Create and verify the cloudharness skill"
status: completed
priority: P2
effort: "3h"
dependencies: []
---

# Phase 1: Create and verify the cloudharness skill

## Overview

Create a project-scoped, contract-driven agent skill and make its documented
tool surface mechanically match the public contract.

## Requirements

- Explain connection preflight, opaque workspace handles, bounded inspection
  and edits, Git review, recovery, and cleanup.
- Prefer structured tools; make `exec_run`, persistent shells, sessions,
  detached tasks, worktrees, skills/hooks/memories, and deployments explicit
  decisions rather than automatic actions.
- Preserve credential, network, repository-control, and approval boundaries.
- Keep the tool inventory in one machine-readable reference and verify exact
  parity between `RunnerOperationSchema`, MCP `TOOL_SPECS`, and that inventory
  in the existing Vitest path; validate marked example inputs against their
  current schemas.

## Related files

- Create: `.agents/skills/cloudharness/SKILL.md`
- Create: `.agents/skills/cloudharness/references/canonical-tool-inventory.md`
- Create: `packages/contracts/test/cloudharness-skill-contract.test.ts`
- Modify: `README.md`

## Implementation steps

1. Initialize the project-local skill and replace starter content with concise,
   security-bounded workflow instructions and generic examples.
2. Add a canonical inventory reference with an explicit marker that a test can
   extract, plus source links to public contract and security documentation.
3. Add a Vitest contract check for the exact three-way inventory and typed
   sample tool calls, then link the skill from the README navigation without
   implying that the remote MCP server distributes the project-local skill.
4. Run focused tests, package validation, and the repository verification gate.

## Success criteria

- [x] The skill covers every behavior required by issue #22 without inventing
  planned functionality.
- [x] The drift test fails for an outdated tool name or parameter example.
- [x] CI-equivalent tests pass. Skill Creator packaging was unavailable because
  its required venv interpreter is absent.

## Risks and rollback

An inventory test can become brittle if it treats ordinary prose as a tool
name. Restrict parsing to explicitly marked inventory and sample-call markers.
Rollback is deletion of the isolated skill, its test, and its README link; no
runtime state or public API changes are involved.
