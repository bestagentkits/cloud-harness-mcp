---
phase: 4
title: "Retire the networkMode advertisement"
status: pending
priority: P2
effort: "2h"
dependencies: [2]
---

# Phase 4: Retire the networkMode advertisement

## Goal

No MCP tool schema, generated reference, or dashboard markup presents the retired
`networkMode` field as usable, while a legacy caller still receives the migration
message instead of a silent ignore.

## Context

`workspace_open` declares `networkMode: z.unknown().optional()`
(`packages/contracts/src/tool-schemas.ts:279`) purely so `superRefine`
(:285-291) can reject it with "networkMode was replaced by networkProfile; choose
'network-none' or 'dependency-access'". Because it is declared, it is advertised
in every MCP client's tool schema and in the generated reference
(`docs-site/reference/tools.md:40` shows `networkMode | any | No`). The field must
stay declared — removing it would let the object strip the key silently — so the
fix is to mark it deprecated and to stop rendering it as a usable parameter.

## Tasks & Steps

### Task 4.1 — Mark the field deprecated in the contract

- **Goal:** MCP clients receive `deprecated: true` plus an explanatory description
  for `networkMode`.
- **Target files and symbols:** `packages/contracts/src/tool-schemas.ts` —
  `schemas.workspace_open` (line ~276-282).
- **Steps:**
  1. Change the field to
     `networkMode: z.unknown().optional().meta({ deprecated: true, description: 'Retired and rejected: this workspace_open field was replaced by networkProfile.' })`.
  2. Leave the `superRefine` rejection and its message unchanged.
- **Success criteria:** `z.toJSONSchema(TOOL_SCHEMA_BY_NAME.workspace_open, { io: 'input' }).properties.networkMode`
  contains `deprecated: true` and the description.
- **Verify:** `npx vitest run packages/contracts/test/contracts.test.ts` exits 0
  after adding an assertion that the serialized `workspace_open` JSON Schema marks
  `networkMode` deprecated, and that parsing with `networkMode: 'bridge'` still
  throws `/networkMode was replaced by networkProfile/`.

### Task 4.2 — Render deprecated parameters honestly in the tool reference

- **Goal:** the generated reference never lists `networkMode` as an ordinary
  optional parameter.
- **Target files and symbols:** `scripts/build-docs-reference.mjs` —
  `formatTypeAndConstraints` / `renderToolMarkdown` table rendering (~line 60-140).
- **Steps:**
  1. In the parameter table renderer, detect `prop.deprecated === true` and render
     the row's Type cell as `` `any` `` prefixed with **Deprecated**, and the
     Constraints cell as the property's `description` (falling back to
     `Retired; rejected at validation`).
  2. Do not drop the row: a reader must still learn that sending the field fails.
- **Success criteria:** regenerated `docs-site/reference/tools.md` marks the
  `networkMode` row deprecated with the rejection explanation.
- **Verify:** `npm run docs:reference && npm run docs:check` exits 0, and
  `grep -n "Deprecated" docs-site/reference/tools.md` lists the `networkMode` row.

### Task 4.3 — Remove the legacy values from the dashboard dialog

Covered by Phase 2 Task 2.3 (same file, same edit); this task only records the
dependency so the two phases are not edited concurrently.

- **Verify:** `grep -rn "networkMode" apps/api/dashboard apps/api/test` prints
  nothing.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

## Guardrails
- The deprecation rejection stays; never accept or translate `networkMode`, and
  never map `bridge` onto `dependency-access`.
- Generated files are produced by the generator, never by hand.
