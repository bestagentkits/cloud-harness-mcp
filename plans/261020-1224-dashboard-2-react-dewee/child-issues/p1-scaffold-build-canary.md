# feat(dashboard): P1 React scaffold, hashed build, manifest serving and canary toggle (#458)

Parent: #458 · Decision: [ADR 0005](../../../docs/adr/0005-dashboard-react-rewrite.md) · Inventory: [parity matrix](../../../docs/dashboard-parity-matrix.md)

## Scope
- Create `apps/dashboard` workspace: React 19, TypeScript `strict`, Vite, Tailwind v4, shadcn/ui on Radix, TanStack Router (file routes) + Query v5, Vitest + Testing Library, Playwright + axe.
- Root scripts: dashboard `lint`, `typecheck`, `test`, `build`, `test:e2e`; wire into `npm run verify` and `.github/workflows/ci.yml`.
- Semantic tokens ported from `apps/api/dashboard/dashboard.css` (OKLCH, opaque `-line`, both themes); self-hosted Geist Sans/Mono WOFF2 + OFL license file.
- `vite build` → hashed assets + `.vite/manifest.json`; API image contains `apps/dashboard/dist`.
- `apps/api/src/dashboard-assets.ts`: manifest-derived fixed allowlist, immutable cache for hashed files, `no-store` shell, previous-release assets kept for the rolling window; startup fails in `react` mode if manifest invalid.
- Shell selection: `CLOUD_HARNESS_DASHBOARD_UI=legacy|react` (default `legacy`) + per-session canary `?ui=react|legacy` → HttpOnly, Secure, SameSite=Strict, path `/dashboard` cookie, validated on read. Theme cookie first-paint injection works for both shells.
- SPA fallback only for HTML navigations to known route prefixes; never `/dashboard/api/v1/*`, `/dashboard/mcp-oauth/callback`, asset paths, `/mcp*`, terminal output routes.
- CSP: add `font-src 'self'` only. Prove a clean CSP console for the scaffold shell (Dialog, Popover, Toast prototypes) — pick primitives that do not inject `<style>`, or implement the per-response style nonce with a test.
- Placeholder authenticated route ("Overview (preview)") that calls one read BFF endpoint with the session cookie.
- Configuration docs (`docs/configuration.md`, `.env.example`, `packages/contracts/src/config.ts`/`apps/api/src/config.ts`) for the new flag; development docs for the dashboard commands.

## Gates
- Legacy shell and all existing class-(a) suites unchanged and green; `npm run verify` green.
- New tests: manifest allowlist (unknown path 404, traversal rejected), cache headers, fallback never answers API/OAuth/MCP paths, flag + canary cookie selection and validation, CSP header exact match, Playwright smoke under real CSP with zero violations, axe clean on the preview route.
- Bundle budget check against the manifest in CI (ADR 0005 numbers).

## Dependencies
P0 (this ADR + matrix) merged.

## Rollback
Flag defaults to `legacy`; reverting the PR removes the package and the asset-serving branch. No data or runner change.
