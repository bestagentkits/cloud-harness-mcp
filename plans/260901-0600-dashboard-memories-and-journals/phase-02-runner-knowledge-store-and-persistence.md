# Phase 2: Runner Knowledge Store and Persistence

## Context Links
- `apps/runner/src/principal-store.ts`
- `apps/runner/src/state-store.ts`
- `apps/runner/src/metadata-store.ts`
- `apps/runner/test/memories-scoped-store.test.ts`

## Requirements
1. SQLite Schema Version 10 Migration:
   - `knowledge_items`: `id PRIMARY KEY`, `principal_id NOT NULL`, `kind NOT NULL CHECK(kind IN ('memory','journal'))`, `scope NOT NULL CHECK(scope IN ('owner','project','workspace'))`, `project_id TEXT`, `workspace_id TEXT`, `title NOT NULL`, `content NOT NULL`, `content_sha256 NOT NULL`, `journal_type TEXT CHECK(journal_type IN ('engineering-log','decision-record','session-reflection') OR journal_type IS NULL)`, `occurred_at INTEGER`, `generation INTEGER NOT NULL CHECK(generation > 0)`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`, `expires_at INTEGER`, `deleted_at INTEGER`, `provenance_json TEXT NOT NULL`.
   - CHECK constraints enforcing valid scope columns:
     - `scope='owner' -> project_id IS NULL AND workspace_id IS NULL`
     - `scope='project' -> project_id IS NOT NULL AND workspace_id IS NULL`
     - `scope='workspace' -> workspace_id IS NOT NULL`
     - `kind='journal' -> journal_type IS NOT NULL AND occurred_at IS NOT NULL`
     - `kind='memory' -> journal_type IS NULL`
   - Partial unique indexes:
     - Active memory title uniqueness within scope: `(principal_id, title) WHERE kind='memory' AND scope='owner' AND deleted_at IS NULL`, etc.
   - `knowledge_tags`: `(principal_id, item_id, tag)`, PK `(principal_id, item_id, tag)`.
   - `knowledge_links`: `(id PRIMARY KEY, principal_id NOT NULL, source_id NOT NULL, target_id NOT NULL, relation NOT NULL, origin NOT NULL, created_at NOT NULL, generation NOT NULL)`.
   - `knowledge_fts`: FTS5 external content table.
   - `knowledge_embeddings`: `(principal_id, item_id, chunk_ordinal, chunk_sha256, vector_blob, dimensions, model_fingerprint, created_at)`.
   - `knowledge_index_jobs`: `(principal_id, item_id, target_generation, content_sha256, state, created_at, updated_at, error_message)`.
2. Implement `KnowledgeStore` & `KnowledgeService` in `apps/runner/src/knowledge-store.ts`:
   - `createItem`, `readItem`, `updateItem`, `deleteItem`, `listItems`, `createLink`, `deleteLink`, `listLinks`.
   - Transactional CAS generation guards on writes/deletions.
   - Automatic sync of FTS and derived wikilink edges on content save.
3. Legacy memory migration:
   - Convert owner/workspace memories to `knowledge_items`.
   - Cleanly map legacy repository memories to matching project or clearly labeled imported Project.

## Validation
- `npx vitest run apps/runner/test/knowledge-store.test.ts`
