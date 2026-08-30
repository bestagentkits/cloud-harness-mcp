# Phase 3: Dashboard Sidebar Navigation & Global Secrets View

## Context & Objectives
- Add **Secrets** to the left sidebar navigation under Configuration (`/dashboard/secrets`).
- Render a dedicated Global Secrets page in `dashboard-render.js` allowing operators to view, create, rotate, edit descriptions, bulk import, and export global secrets.
- Add route handling in `dashboard-router.ts` and `dashboard.js`.

## Requirements
1. **Sidebar Navigation (`apps/api/dashboard/index.html`):**
   - In `<aside id="product-nav">`:
     Under `<p class="nav-group">Configuration</p>`:
     Add `<a href="/dashboard/secrets" data-section="secrets"><svg ...>...</svg>Secrets</a>`.
2. **Dashboard Render (`apps/api/dashboard/dashboard-render.js`):**
   - Export `renderGlobalSecrets(secrets, readiness)`:
     - Header note: "Retained global configuration metadata. Global secrets are available across all projects and workspaces."
     - Table of global secrets with columns: `Name`, `Description`, `State`, `Version & Generation`, `Actions` (Edit Desc, Rotate, Delete).
     - Action buttons: `Bulk import .env`, `Export .env.example`.
     - Single secret create form with `Name`, write-only `Value`, and optional `Description`.
3. **Dashboard Logic (`apps/api/dashboard/dashboard.js`):**
   - Add `loadGlobalSecrets()` handler wired to route `/dashboard/secrets`.
   - Bind global secret create, rotate, update-desc, and delete forms.
   - Bind `open-bulk-import` and `export-env-example` for global secrets (calling `/api/v1/secrets/bulk` and `/api/v1/secrets`).
4. **Router Assets (`apps/api/src/dashboard-assets.ts`):**
   - Add `'/secrets'` to the client-side routes served by `createDashboardAssetsRouter`.

## Files to Modify
- `apps/api/dashboard/index.html`
- `apps/api/dashboard/dashboard-render.js`
- `apps/api/dashboard/dashboard.js`
- `apps/api/src/dashboard-assets.ts`

## Phase 3 Tests
- `apps/api/test/dashboard-ui-contract.test.ts` (asserts `/dashboard/secrets` link and landmark existence).
- `apps/api/test/dashboard-ui-behavior.test.ts` (tests `renderGlobalSecrets` and navigation).
