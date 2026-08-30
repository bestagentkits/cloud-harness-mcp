# Phase 3: Dashboard UI, Description Management & Bulk .env Import

## Context & Objectives
- Update the Dashboard Project/Environment details view to display secret descriptions and allow inline editing without re-entering values.
- Implement Bulk `.env` Import Modal in the Dashboard with client-side parsing, comment-to-description extraction, live diff preflight (Created/Rotated/Skipped/Rejected), and single-click execution.
- Implement Export `.env.example` manifest (key names and version comments only, values write-only).

## Requirements
1. **Secret Table with Description (`apps/api/dashboard/dashboard-render.js`):**
   - Render `description` in the secret table/card. If empty, show optional add trigger or placeholder.
   - Add single-secret create form with `Name`, write-only `Value`, and optional `Description` inputs.
   - Add Edit Description modal or inline form calling `PATCH /api/v1/environments/:id/secrets/:name` (`secret_update`).
2. **Bulk .env Import Modal:**
   - Textarea input for pasting `.env` contents.
   - Parser:
     - Parse `KEY=VALUE`, `export KEY="VALUE"`, `# comment` lines.
     - Contiguous comment lines directly preceding a variable are extracted as its `description`.
     - Blank lines detach section/banner comments.
   - Safety validation:
     - Run `validateSecretName` against each key.
     - Mark forbidden/reserved keys as `REJECTED`.
     - Compare against existing secrets in the environment:
       - If absent: `CREATE (new secret)`
       - If present: `ROTATE (new value provided)`
   - Live diff preview box rendered in real-time as the operator pastes.
   - Submit executes individual create/rotate requests and reports per-key results.
3. **Export `.env.example` Button:**
   - Generates and triggers download of `.env.example` containing:
     ```bash
     # Description for DB
     DATABASE_URL=
     # Description for Stripe
     STRIPE_SECRET_KEY=
     ```
   - Values are strictly omitted (write-only guarantee).
4. **CSS & Design Standards (`apps/api/dashboard/dashboard.css`):**
   - Follow OKLCH color system, industrial console styling, and CSP `default-src 'none'` rules.
   - Responsive design verified at 375px mobile breakpoint and both light/dark themes.

## Files to Modify
- `apps/api/dashboard/dashboard-render.js`
- `apps/api/dashboard/dashboard.js`
- `apps/api/dashboard/dashboard.css`
- `apps/api/dashboard/index.html` (if template dialog elements are needed)

## Tests
- `apps/api/test/dashboard-ui-contract.test.ts`
- `apps/api/test/dashboard-ui-behavior.test.ts`
