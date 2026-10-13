# Phase 3: API MCP Server & Dashboard UI

## Context Links
- [`apps/api/src/mcp-server.ts`](../../apps/api/src/mcp-server.ts)
- [`apps/api/src/dashboard-control-router.ts`](../../apps/api/src/dashboard-control-router.ts)
- [`apps/api/src/dashboard-response.ts`](../../apps/api/src/dashboard-response.ts)
- [`apps/api/dashboard/dashboard-render.js`](../../apps/api/dashboard/dashboard-render.js)
- [`apps/api/dashboard/dashboard.js`](../../apps/api/dashboard/dashboard.js)
- [`apps/api/src/local/local-workspace-backend.ts`](../../apps/api/src/local/local-workspace-backend.ts)

## Requirements
1. **MCP Server Tool Registration:**
   - Verify `TOOL_SPECS` automatically registers `artifacts_snapshot`, `artifacts_list`, `artifacts_read`, `artifacts_restore`, `artifacts_delete` in `createCloudHarnessServer()`.
   - Update `local-workspace-backend.ts` to return informative unsupported error for artifact operations when running in local stdio mode.
2. **Dashboard Control Router & Response:**
   - In `dashboard-control-router.ts`:
     - Add `GET /api/v1/artifacts/:artifactId` -> `artifact_read`.
     - Add `GET /api/v1/artifacts/:artifactId/download` -> dedicated download endpoint with `Content-Disposition: attachment; filename="<logicalName>"`.
     - Add `POST /api/v1/artifacts/:artifactId/restore` or `POST /api/v1/artifacts/restore` -> `artifact_restore`.
   - In `dashboard-response.ts`:
     - Add `artifact_read` and `artifact_restore` to `DashboardResponseOperation`.
     - Pick allowed fields for responses.
3. **Dashboard Web UI:**
   - In `dashboard-render.js`:
     - Add a "Download" link/button next to each artifact in the artifact table pointing to the download endpoint.
   - In `dashboard.js`:
     - Bind download interactions if needed.

## Validation
- `apps/api/test/mcp-server.test.ts`
- `apps/api/test/dashboard-control-router.test.ts`
- `apps/api/test/dashboard-ui-contract.test.ts`
