# Phase 1: Contracts and Tool Schemas

## Requirements
- Extend `github_action` discriminated union in `packages/contracts/src/tool-schemas.ts`:
  1. `pr_create`: add `draft: z.boolean().default(false)` and optional `labels: z.array(z.string()).optional()`.
  2. `pr_update`: add discriminated union schema for `action: 'pr_update'`, requiring `prNumber: z.number().int().positive()`, and optional `title`, `body`, `base`, `state: z.enum(['open', 'closed'])`, with refinement requiring at least one field.
  3. `pr_comment`: add schema for `action: 'pr_comment'`, requiring `prNumber: z.number().int().positive()`, `body: z.string().min(1).max(65_536)`, and optional `idempotencyKey`.
  4. `issue_create`: add optional `labels: z.array(z.string()).optional()` and `assignees: z.array(z.string()).optional()`.
- Add test coverage in `packages/contracts/test/contracts.test.ts`.

## Files to modify
- `packages/contracts/src/tool-schemas.ts`
- `packages/contracts/test/contracts.test.ts`

## Validation
- `npm run build -w @cloud-harness/contracts`
- `vitest run packages/contracts/test/contracts.test.ts`
