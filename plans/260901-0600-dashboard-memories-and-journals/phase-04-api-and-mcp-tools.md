# Phase 4: API and MCP Tools

## Context Links
- `apps/api/src/mcp-server.ts`
- `apps/runner/src/workspace-service.ts`
- `apps/api/src/dashboard-control-router.ts`
- `apps/api/src/dashboard-types.ts`

## Requirements
1. Wire 9 MCP Knowledge Tools:
   - In `apps/runner/src/workspace-service.ts` & `apps/api/src/mcp-server.ts`, register handlers for:
     - `knowledge_create`
     - `knowledge_read`
     - `knowledge_update`
     - `knowledge_delete`
     - `knowledge_list`
     - `knowledge_search`
     - `knowledge_link`
     - `knowledge_unlink`
     - `knowledge_graph`
2. Dashboard Control Router Endpoints:
   - `GET /api/v1/knowledge` (list/filter items)
   - `POST /api/v1/knowledge` (create item)
   - `GET /api/v1/knowledge/:id` (read item with links)
   - `PUT /api/v1/knowledge/:id` (update item with CAS)
   - `DELETE /api/v1/knowledge/:id` (delete item with CAS)
   - `POST /api/v1/knowledge/search` (hybrid search)
   - `GET /api/v1/knowledge/graph` (neighborhood graph)
   - `POST /api/v1/knowledge/links` (create link)
   - `DELETE /api/v1/knowledge/links/:id` (delete link)
3. Concurrency and Error Handling:
   - Handle CAS conflicts cleanly, returning HTTP 409 Conflict with `Base`, `Current`, and `Yours` representation.
   - Enforce CSRF protection and JSON payload verification.

## Validation
- `npx vitest run apps/api/test/knowledge-api.test.ts`
