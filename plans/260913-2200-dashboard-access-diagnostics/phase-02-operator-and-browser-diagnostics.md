# Phase 2: Operator and Browser Diagnostics

## Context Links
- Plan: `plans/260913-2200-dashboard-access-diagnostics/plan.md`
- Code: `apps/api/src/auth.ts`, `apps/api/src/access-diagnostic.ts`, `apps/api/src/logging.ts`,
  `apps/api/src/index.ts`
- Tests: `apps/api/test/access-auth.test.ts`, `apps/api/test/api-key-gateway-auth.test.ts`

## Requirements
- One shared pino logger (`apps/api/src/logging.ts`) owned by `apps/api/src/index.ts` and the
  auth middlewares; no second logger convention.
- Every rejected Access assertion logs one `warn` with `reason`, `method`, `path` (no query
  string), and `host`. The assertion, its claims, headers, and query strings are never logged.
- `accessAssertionAuth` answers a request whose `Accept` includes `text/html` with a 401 HTML
  diagnostic from `apps/api/src/access-diagnostic.ts` plus
  `Content-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- Every other client keeps `401 {"error":"authentication_failed"}` with
  `WWW-Authenticate: Bearer realm="cloud-harness-mcp"` unchanged, including the API-key
  gateway surface and owner-bearer mode.
- Export `AuthenticatedRequest` so the middleware contract is a named type.

## Tasks
1. Classify rejection sites in `accessAssertionAuth`, `bearerAuth`, and `apiKeyGatewayAuth`;
   identity-class mismatches report `assertion_identity_not_accepted`, and unexpected errors
   report `unexpected_verification_error`.
2. Render the diagnostic page from the reason code with a bounded hint per reason and four
   fixed checks.
3. Test both response shapes for the same rejected navigation and assert the page never
   echoes a token.

## Verification
```bash
npx vitest run apps/api/test/access-auth.test.ts apps/api/test/api-key-gateway-auth.test.ts
npm run typecheck -w @cloud-harness/api
```
Success: HTML for navigations, JSON for API clients, reason code present, no assertion text in
the page.
