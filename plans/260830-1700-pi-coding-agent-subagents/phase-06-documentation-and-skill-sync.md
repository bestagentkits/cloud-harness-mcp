# Phase 06: Documentation, Docs-Site, Skill Guidance & Plugin Sync

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 05: [phase-05-tests-and-verification.md](phase-05-tests-and-verification.md)
- AGENTS.md requirements: `AGENTS.md`

## Requirements
1. **Repository & Architecture Documentation (`docs/`):**
   - Update `docs/mcp-api.md` with the 6 new `agent_*` tools, lifecycle semantics, idempotency, and error codes.
   - Update `docs/system-architecture.md` with the Model Gateway, dedicated agent container topology, and security invariants.
   - Update `docs/security-model.md` with Pi untrusted workload constraints and lease mechanisms.
   - Update `docs/configuration.md` with agent profile and gateway configuration variables.
2. **Official User Docs Site (`docs-site/`):**
   - Update `docs-site/` pages (AI tools, reference, architecture, troubleshooting).
   - Run `npm run docs:reference` or `npm run docs:build` to ensure docs site build passes.
3. **Agent Skill & MCP Tool Guidance (`.agents/skills/cloudharness/`):**
   - Update `.agents/skills/cloudharness/SKILL.md` to document the 6 `agent_*` tools and effective usage workflows.
   - Update reference files in `.agents/skills/cloudharness/references/`.
4. **Plugin Synchronization:**
   - Run `npm run plugin:sync` to ensure `.agents/skills/cloudharness/` and `plugins/cloud-harness/skills/cloudharness/` remain byte-identical.
   - Verify skill contract compliance by running `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`.
5. **Live Canary Runbook:**
   - Document the owner-authorized, low-budget real-provider canary procedure required for closing Issue #19.

## Files to Modify / Create
- `docs/mcp-api.md`
- `docs/system-architecture.md`
- `docs/security-model.md`
- `docs/configuration.md`
- `docs-site/`
- `.agents/skills/cloudharness/SKILL.md`
- `.agents/skills/cloudharness/references/`
- `plugins/cloud-harness/skills/cloudharness/`

## Tests & Validation
- `npm run plugin:sync`
- `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`
- `npm run docs:build`
