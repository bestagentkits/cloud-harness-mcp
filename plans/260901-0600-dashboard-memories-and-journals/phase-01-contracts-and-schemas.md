# Phase 1: Contracts and Schemas

## Context Links
- `packages/contracts/src/tool-schemas.ts`
- `packages/contracts/src/runner-api.ts`
- `packages/contracts/src/internal-runner-api.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/contracts.test.ts`

## Requirements
1. Create `packages/contracts/src/knowledge-schemas.ts` containing:
   - `KnowledgeKindSchema`: `'memory' | 'journal'`
   - `KnowledgeScopeSchema`: `'owner' | 'project' | 'workspace'`
   - `JournalTypeSchema`: `'engineering-log' | 'decision-record' | 'session-reflection'`
   - `KnowledgeRelationSchema`: `'relates-to' | 'references' | 'supports' | 'contradicts' | 'supersedes'`
   - `KnowledgeLinkOriginSchema`: `'manual' | 'wikilink'`
   - `KnowledgeItemSchema` & `KnowledgeLinkSchema`
   - `KnowledgeSearchQuerySchema` & `KnowledgeSearchResultSchema`
   - `KnowledgeGraphQuerySchema` & `KnowledgeGraphResultSchema`
   - `KnowledgeConflictStateSchema` (for Base / Current / Yours 3-way resolution)
2. Define MCP Tool schemas in `packages/contracts/src/tool-schemas.ts`:
   - `knowledge_create`
   - `knowledge_read`
   - `knowledge_update`
   - `knowledge_delete`
   - `knowledge_list`
   - `knowledge_search`
   - `knowledge_link`
   - `knowledge_unlink`
   - `knowledge_graph`
3. Define Runner operations in `runner-api.ts` and Dashboard BFF operations in `internal-runner-api.ts`.
4. Add comprehensive contract test suite in `packages/contracts/test/knowledge-contracts.test.ts`.

## Validation
- `npm test -w @cloud-harness/contracts`
