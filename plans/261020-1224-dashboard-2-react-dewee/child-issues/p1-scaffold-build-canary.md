# feat(dashboard): P1 React scaffold, hashed build, manifest serving and canary toggle (#458)

Parent: #458 · Decision: [ADR 0005](../../../docs/adr/0005-dashboard-react-rewrite.md) · Inventory: [parity matrix](../../../docs/dashboard-parity-matrix.md)

## Scope
- Create `apps/dashboard` workspace: React 19, TypeScript `strict`, Vite, Tailwind v4, shadcn/ui on Radix, TanStack Router (file routes) + Query v5, Vitest + Testing Library, Playwright + axe.
- Root scripts: dashboard `lint`, `typecheck`, `test`, `build`, `test:e2e`; wire into `npm run verify` and `.github/workflows/ci.yml`.
- Semantic tokens ported from `apps/api/dashboard/dashboard.css` (OKLCH, opaque `-line`, both themes); self-hosted Geist Sans/Mono WOFF2 + OFL license file.
- `vite build` → hashed assets + `.vite/manifest.json`. The API image (`docker/api.Dockerfile`) copies `apps/dashboard/dist` **in addition to** `apps/api/dashboard/`. Keep the legacy shell in the image: `dashboard-assets.ts` reads its `index.html` at module load, so dropping it would crash the API and break the `legacy` rollback. Its removal is a P6 follow-up.
- `apps/api/src/dashboard-assets.ts`: manifest-derived fixed allowlist; hashed files served with the existing `Cache-Control: private, max-age=31536000, immutable` (never `public`, assets sit behind Access); `no-store` shell.
- Manifest validation at startup whenever the React shell is selectable (flag `react` or canary allowed). With flag `react`, an absent or invalid manifest fails API startup (never a silent legacy fallback). In canary-only mode it disables the canary, logs the reason, and legacy keeps serving. One startup log line names the active shell and canary state.
- Chunk-load failure (for example a tab open across a deploy): the SPA does one guarded full reload of the shell (per-tab marker prevents loops), then an error state. Keeping previous-release assets in the image is out of scope.
- Shell selection: `CLOUD_HARNESS_DASHBOARD_UI=legacy|react` (default `legacy`) + per-session canary `?ui=react|legacy` → HttpOnly, Secure, SameSite=Strict, path `/dashboard` cookie, validated on read. Theme cookie first-paint injection works for both shells.
- SPA fallback is an allowlist: only HTML navigations to known route prefixes; unknown `/dashboard/*` paths still 404; never `/dashboard/api/v1/*`, `/dashboard/mcp-oauth/callback`, asset paths, `/mcp*`, terminal output routes.
- CSP: add `font-src 'self'` only. Prove a clean CSP console for the scaffold shell (Dialog, Popover, Toast prototypes) — pick primitives that do not inject `<style>`, or implement the per-response style nonce with a test.
- Placeholder authenticated route ("Overview (preview)") that calls one read BFF endpoint with the session cookie.
- Configuration docs (`docs/configuration.md`, `.env.example`, `packages/contracts/src/config.ts`/`apps/api/src/config.ts`) for the new flag; development docs for the dashboard commands.

## Gates
- Legacy shell and all existing class-(a) suites unchanged and green; `npm run verify` green.
- New tests: manifest allowlist (unknown path 404, traversal rejected), cache headers (`private, immutable` for hashed files, `no-store` shell), missing/invalid manifest fails startup with flag `react` and disables the canary (legacy keeps serving) in canary-only mode, startup log names the active shell, guarded chunk-load reload, `dashboard-app-mount` gains React-shell cases with nothing removed, unknown `/dashboard/*` path 404, fallback never answers API/OAuth/MCP paths, flag + canary cookie selection and validation, CSP header exact match, Playwright smoke under real CSP with zero violations, axe clean on the preview route.
- Bundle budget check against the manifest in CI (ADR 0005 numbers).

## Dependencies
P0 (this ADR + matrix) merged.

## Rollback
Flag defaults to `legacy`; reverting the PR removes the package and the asset-serving branch. No data or runner change.
