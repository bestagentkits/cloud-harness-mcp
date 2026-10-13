# Plan: Extend API Key Max Lifetime to 3,650 Days for Zero-Reauth AI Clients

## Metadata
- **Status:** completed
- **Branch:** `feature/extend-auth-ttl-and-api-keys`
- **Goal:** Resolve frequent MCP server sign-out and re-authentication loops for AI tools (Claude Code, Cursor, Codex, ChatGPT, etc.) by expanding API key lifetime up to 3,650 days (~10 years), providing explicit operator troubleshooting guides for Cloudflare Access Managed OAuth Grant session duration, and documenting zero-reauth static client setups.
- **Created:** 2026-08-28

---

## Executive Summary

### Problem
Users connecting AI tools (Claude Code, Codex, Cursor, ChatGPT, etc.) to Cloud Harness MCP at `https://harness.zuey.me/mcp` experience frequent authentication expirations and are repeatedly prompted to re-authenticate via browser OAuth.

### Root Causes
1. **Managed OAuth Grant Duration vs Access Token Lifetime:** `https://harness.zuey.me/mcp` uses Cloudflare Access Managed OAuth. Client reauthentication prompts are governed primarily by **Managed OAuth → Grant session duration** (refresh token lifetime). If clients do not support automatic refresh or when the Grant session expires, the client prompts for interactive browser re-authentication.
2. **API Key Maximum Expiration Capped at 365 Days:** The static API key gateway (`https://api.harness.zuey.me/mcp`) allows AI tools to authenticate without interactive browser prompts via `Authorization: Bearer chm_key_...`. However, contracts (`packages/contracts/src/api-key-api.ts`), backend routes (`apps/api/src/dashboard-control-router.ts`), frontend validation/markup (`apps/api/dashboard/dashboard.js`, `dashboard-render.js`), and runner store (`apps/runner/src/api-key-store.ts`) restricted API key creation to a maximum of 365 days.

### Solution
1. **Export and Enforce `API_KEY_MAX_EXPIRY_DAYS = 3_650` across all layers:**
   - Export `API_KEY_MAX_EXPIRY_DAYS = 3_650` in `packages/contracts/src/api-key-api.ts`.
   - Update `ApiKeyManagementRequestSchema` to use `z.number().int().min(1).max(API_KEY_MAX_EXPIRY_DAYS)`.
   - Update `apps/api/src/dashboard-control-router.ts` to validate `z.number().int().min(1).max(API_KEY_MAX_EXPIRY_DAYS)`.
   - Update `apps/runner/src/api-key-store.ts:67` to enforce `expiresInDays > API_KEY_MAX_EXPIRY_DAYS`.
   - Update `apps/api/dashboard/dashboard.js` validation to allow up to 3,650 days.
   - Update `apps/api/dashboard/dashboard-render.js` form rendering to specify `max="3650"`.
2. **Comprehensive Documentation across Live Surfaces:**
   - Update `README.md`, `docs/mcp-api.md`, `docs/troubleshooting.md`, `docs/configuration.md`, `docs/deployment.md`, `docs/security-model.md`, `docs-site/connect.md`, and `docs-site/dashboard/api-keys.md`.
   - Distinguish Managed OAuth Grant session duration (refresh token lifetime) from Access Application / Policy session duration (browser dashboard).
   - Provide clear instructions for setting up AI tools with `https://api.harness.zuey.me/mcp` and long-lived API keys for zero interactive reauthentication.
3. **Boundary and Behavioral Tests:**
   - Contract tests (3650 valid, 3651 rejected, non-integers rejected).
   - Runner store tests (3650 valid with exact timestamp math, 3651 rejected).
   - API router tests (3650 reaches runner, 3651 rejected immediately).
   - UI behavior & contract tests (form validates 3650, renders `max="3650"`).

---

## Phase Breakdown

| Phase | Title | Status | Priority | Effort | Dependencies |
|---|---|---|---|---|---|
| [Phase 01](phase-01-contracts-and-api-key-duration.md) | Contracts & API Key Max Duration Extension | completed | P1 | 1h | [] |
| [Phase 02](phase-02-dashboard-ui-form-updates.md) | Dashboard UI Form Updates | completed | P1 | 1h | [Phase 01] |
| [Phase 03](phase-03-documentation-and-troubleshooting-guides.md) | Documentation & Zero-Reauth Guides | completed | P2 | 1h | [Phase 02] |
| [Phase 04](phase-04-verification-and-tests.md) | Test Suite & Gate Verification | completed | P1 | 1h | [Phase 01, Phase 02, Phase 03] |

---

## Acceptance Criteria
- [x] `packages/contracts/src/api-key-api.ts` exports `API_KEY_MAX_EXPIRY_DAYS = 3_650` and validates `1..3650`.
- [x] `apps/runner/src/api-key-store.ts` enforces `1..3650` days and accurately computes `expiresAt = now + expiresInDays * DAY_MS`.
- [x] `apps/api/src/dashboard-control-router.ts` allows creating API keys with `expiresInDays` up to 3,650 days.
- [x] `apps/api/dashboard/dashboard.js` and `dashboard-render.js` validate and render form with `max="3650"`.
- [x] Documentation across `README.md`, `docs/`, and `docs-site/` accurately reflects 1–3,650 days, explains Cloudflare Managed OAuth Grant session duration vs Access browser session durations, and explains static API key setup.
- [x] Full test suite and repository gates (`npm run verify`, `npm run plugin:check`) pass with 0 errors.
