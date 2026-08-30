# Phase 6: Adversarial Output-Boundary, Verification & Docs Sync

## Context Links
- Plan: `plans/260830-0700-15-provenance-aware-workspace-context-skills-memories-hooks/plan.md`
- Code: `apps/api/test/adversarial-output-boundary.test.ts`, `docs/`, `docs-site/`, `.agents/skills/cloudharness/`, `plugins/cloud-harness/`

## Requirements
- Layered Adversarial Output-Boundary & Prompt-Injection Tests:
  - **API Formatter Layer (`apps/api/test/adversarial-output-boundary.test.ts`):**
    - Fixture containing fake SYSTEM headers, fake Markdown/JSON delimiters, NUL bytes, ANSI escapes, and prompt injection
    - Verify `structuredContent` encapsulates all repository content under `result.data` with `trust: "untrusted-executor"`
    - Verify text projection (`content[0].text`) formats content with trusted boundary labels and JSON-escaped strings
  - **Runner SQLite Storage Layer (`apps/runner/test/memories-scoped-store.test.ts`):**
    - Verify malicious repository files cannot create persistent SQLite rows without explicit authenticated mutation tools
  - **Docker Isolation Layer (`test/integration/` or runner tests):**
    - Verify hook and skill sandbox enforces no-network, dropped capabilities, non-root UID, and no secret leakage
- End-to-End Workflow Verification:
  - Test complete workflow: `workspace_open` -> `workspace_context` -> `memories_write` -> `memories_search` -> `skills_list` -> `skills_run` -> `hooks_activate` -> `git_commit` (pre_commit hook) -> `workspace_close` (cleanup)
- Sync All Documentation and Skill Files:
  - Update `docs/mcp-api.md`, `docs/security-model.md`, `docs/system-architecture.md`
  - Update `docs-site/reference/tools.md`, `docs-site/ai-tools/`
  - Update `.agents/skills/cloudharness/SKILL.md` and reference files
  - Run `npm run plugin:sync` to ensure byte-identical plugin skills
  - Run `npm run docs:reference` to regenerate reference docs if needed
  - Verify skill contract: `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`
- Full Repository Verification Suite:
  - Run `npm run test:unit`, `npm run test:integration`, `npm run lint`, `npm run typecheck`

## Files to Modify/Create
- `apps/api/test/adversarial-output-boundary.test.ts` (new test file)
- `docs/mcp-api.md`
- `docs/security-model.md`
- `docs/system-architecture.md`
- `.agents/skills/cloudharness/SKILL.md`
- `.agents/skills/cloudharness/references/`
- `plugins/cloud-harness/`

## Implementation Steps
1. Author adversarial test suite in `apps/api/test/adversarial-output-boundary.test.ts`.
2. Update documentation and agent skill guidance across `docs/`, `docs-site/`, and `.agents/skills/`.
3. Run `npm run plugin:sync` and verify skill contract test passes.
4. Run full repository verification suite.

## Tests & Validation
- `npm test apps/api/test/adversarial-output-boundary.test.ts`
- `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`
- `npm run test:unit`
- `npm run test:integration`
- `npm run lint`
- `npm run typecheck`
