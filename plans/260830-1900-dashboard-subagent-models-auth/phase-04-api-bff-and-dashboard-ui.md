# Phase 04: API BFF Endpoints & Dashboard UI

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 01: [phase-01-contracts-and-schemas.md](phase-01-contracts-and-schemas.md)
- Dashboard Control Router: `apps/api/src/dashboard-control-router.ts`
- Dashboard UI Files: `apps/api/dashboard/` (`index.html`, `dashboard.js`, `dashboard.css`, `dashboard-api.js`, `dashboard-render.js`)
- Design Guidelines: `docs/design-guidelines.md`

## Requirements

1. **Dashboard Control Routes (`apps/api/src/dashboard-control-router.ts`):**
   - Register endpoints:
     - `GET /api/v1/provider-credentials`
     - `POST /api/v1/provider-credentials`
     - `PUT /api/v1/provider-credentials/:id/rotate`
     - `DELETE /api/v1/provider-credentials/:id`
     - `GET /api/v1/agent-model-profiles`
     - `POST /api/v1/agent-model-profiles`
     - `PATCH /api/v1/agent-model-profiles/:id`
     - `POST /api/v1/agent-model-profiles/:id/activate`
     - `POST /api/v1/agent-model-profiles/:id/disable`
     - `DELETE /api/v1/agent-model-profiles/:id`
     - `GET /api/v1/agent-model-config-status`
   - Apply CSRF, session validation, and principal derivation.
   - Enforce non-enumerating error responses (404 on foreign ID).

2. **Dashboard Navigation & Page Structure (`apps/api/dashboard/index.html`):**
   - Add `Models` nav link under `Configuration` group (`data-section="models"`).
   - Add `#models-content` section with `Model profiles` and `Provider credentials` tab buttons.
   - Preserve single `<h1>`, skip link, and accessibility landmarks.

3. **Dialogs & Forms:**
   - Create `<dialog id="provider-credential-dialog">` for adding/rotating credentials:
     - `type="password"`, `autocomplete="new-password"`, write-only notice, show/hide toggle.
   - Create `<dialog id="model-profile-dialog">` for configuring profiles:
     - Model name, API mode, Credential selector, Pricing USD/1M inputs, Token & Cost limit inputs, 10 Proxy tool checkboxes.
     - SSRF error feedback in live announcer.

4. **Rendering & State Management (`dashboard-render.js`, `dashboard.js`, `dashboard-api.js`):**
   - Escape all user strings (labels, model names, URLs).
   - Render fixed masked indicator `Configured · v<N>`. Never interpolate secret.
   - Implement optimistic updates with 409 conflict draft preservation.
   - Clear password inputs immediately on submit or modal close.

5. **Styling & Accessibility (`dashboard.css`):**
   - OKLCH color tokens, responsive table/card layout, light/dark/system themes, touch targets ≥44px, 375px mobile viewport.

## Files to Modify / Create
- `apps/api/src/dashboard-control-router.ts` (modify: add model routes)
- `apps/api/dashboard/index.html` (modify: add navigation and dialogs)
- `apps/api/dashboard/dashboard.css` (modify: add models styles)
- `apps/api/dashboard/dashboard-api.js` (modify: add model API calls)
- `apps/api/dashboard/dashboard-render.js` (modify: add models renderers)
- `apps/api/dashboard/dashboard.js` (modify: add models controllers)
- `apps/api/test/dashboard-models-router.test.ts` (create)
- `apps/api/test/dashboard-ui-contract.test.ts` (modify: add models assertions)

## Tests & Validation
- `npx vitest run apps/api/test/dashboard-models-router.test.ts`
- `npx vitest run apps/api/test/dashboard-ui-contract.test.ts`
- `npm run typecheck -w @cloud-harness/api`
