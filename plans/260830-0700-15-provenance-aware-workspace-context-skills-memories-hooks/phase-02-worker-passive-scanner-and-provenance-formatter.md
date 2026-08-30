# Phase 2: Worker Passive Scanner, Runner Context Wire-up & Provenance Formatter

## Context Links
- Plan: `plans/260830-0700-15-provenance-aware-workspace-context-skills-memories-hooks/plan.md`
- Code: `worker/harness-worker.mjs`, `apps/runner/src/workspace-service.ts`, `apps/api/src/local/local-workspace-backend.ts`, `apps/api/src/mcp-response-text.ts`

## Requirements
- Passive file discovery in `worker/harness-worker.mjs`:
  - Allowlisted instruction files: `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `CLAUDE.local.md`, `.cursor/rules/**/*.mdc`, `.cursorrules`, `.aider.conf.yml`, `CONVENTIONS.md`, `.github/copilot-instructions.md`
  - Language/project manifests: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`, `Makefile`, `justfile`
  - Strict containment: `O_NOFOLLOW` / `lstat` checks, regular files only, no symlink following, no parent traversal
  - Zero dynamic execution: NO package manager runs, NO dynamic script execution, NO Git hook execution
  - Hard bounds: max 256 candidate files, max 8 KiB excerpt per file, 250ms deadline, 32 KiB default response budget
- Runner Context Wire-up in `apps/runner/src/workspace-service.ts`:
  - Connect `WorkspaceService.execute('workspace_context', ...)` to worker's scanner
  - Validate returned file facts, strip any worker-asserted trust fields, stamp canonical `provenance` metadata
  - Merge workspace/branch/capability metadata with bounded manifest and skills summary
  - Also update `LocalWorkspaceBackend` in `apps/api/src/local/local-workspace-backend.ts` for stdio local mode
- Provenance-Aware Formatter in `apps/api/src/mcp-response-text.ts`:
  - Render manifest items with trusted boundary markers
  - JSON-escape untrusted repository strings in text projection to prevent delimiter escape
  - Structured output (`structuredContent`) preserves nested `result.data` under `trust: "untrusted-executor"`

## Files to Modify/Create
- `worker/harness-worker.mjs`
- `apps/runner/src/workspace-service.ts`
- `apps/api/src/local/local-workspace-backend.ts`
- `apps/api/src/mcp-response-text.ts`
- `apps/api/test/mcp-response-text.test.ts`
- `apps/runner/test/bounded-workspace-file-reader.test.ts`

## Implementation Steps
1. Implement `scanWorkspaceContext(input)` in `worker/harness-worker.mjs` with static parsers for Claude, Codex, Cursor, Aider instruction files and build manifests.
2. Update `WorkspaceService.execute('workspace_context')` in `apps/runner/src/workspace-service.ts` to call worker scanner, attach provenance, and merge manifest into response data.
3. Update `LocalWorkspaceBackend.call('workspace_context')` in `apps/api/src/local/local-workspace-backend.ts`.
4. Update `formatToolResultText()` in `apps/api/src/mcp-response-text.ts` to render provenance-aware context manifest text.
5. Add unit tests for scanner containment, runner context enrichment, and text projection formatting.

## Tests & Validation
- `npm test apps/api/test/mcp-response-text.test.ts`
- `npm test apps/runner/test/workspace-capabilities.test.ts`
- Verify sentinel executable remains untouched and no shell process spawns during scanning.
