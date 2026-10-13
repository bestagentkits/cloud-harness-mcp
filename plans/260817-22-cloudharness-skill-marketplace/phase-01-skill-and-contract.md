# Phase 1: skill and MCP contract

Status: complete

## Requirements

- Keep `.agents/skills/cloudharness` as the canonical repository-local skill.
- Replace the inventory-only reference with progressive, self-contained guides.
- Improve tool descriptions and audit annotations for marketplace scanning.
- Mark examples so contract tests parse them against live schemas.

## Files

- `.agents/skills/cloudharness/**`
- `packages/contracts/src/tool-schemas.ts`
- `packages/contracts/test/cloudharness-skill-contract.test.ts`

## Validation

- Exact tool coverage and schema-valid examples.
- No external repository-relative links or source-path mentions.
- Skill and reference files remain below 300 lines each.

## Risks and rollback

Documentation drift is controlled by contract tests. Annotation changes affect
approval UX only and must describe actual worst-case tool behavior.

## Evidence

- All 52 public operations are documented exactly once.
- Nine marked examples parse against live input schemas.
- Docker E2E verifies corrected result fields and Git commit-all behavior.
- Published destructive annotations are asserted through MCP tool listing.
