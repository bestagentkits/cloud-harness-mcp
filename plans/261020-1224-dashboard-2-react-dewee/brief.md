# Dashboard 2.0 (#458) — locked handoff brief

Status: confirmed by owner 2026-10-20 (ak:atoz gate 1). Gate 2 (prerequisites) pending.

## Objective
Replace the vanilla-JS Dashboard renderer with a React + strict TS app in `apps/dashboard`
(Geist-inspired), preserving BFF, Access, CSRF, CSP, URLs and sensitive contracts. Deliver via
phase PRs, merge, and cut over on production. Embed Dewee webchat; let a Dewee agent control the
dashboard (client tools) and Cloud Harness (MCP).

## Done means
1. ADR 0005 supersedes #220 no-framework constraint; design-guidelines, AGENTS, development, docs-site updated.
2. Old→new parity matrix covering every page, route, dialog, mutation, shortcut, API, terminal lifecycle.
3. Child issues P1–P6 linked to #458; one gated PR per phase.
4. `apps/dashboard`: Vite, React, TanStack Router/Query, Tailwind v4, shadcn (Radix); hashed assets + manifest,
   same-origin at `/dashboard`; CSP without `unsafe-inline`/CDN; `/dashboard/api/v1`, OAuth callback, MCP never
   swallowed by SPA fallback.
5. Canary flag + tested one-step UI-only rollback.
6. Full page/flow parity incl. secrets, API keys, OAuth, terminal, files, git, models, packages, deploy,
   automation; terminal PTY survives route changes.
7. Playwright E2E: A→B, A→B→C, Back/Forward, slow/out-of-order, 401/409/429/5xx — zero route mismatches;
   measured nav visual response p95 < 100ms.
8. UX/CX/AX polish: micro-animation feedback, nav + job progress bars, wizards (workspace open, agent spawn,
   MCP OAuth, deploy), route lazy load + hover/focus prefetch, reload restores URL state / non-secret drafts /
   wizard step / tabs / scroll; preferences (theme, font size, density), command palette, dialog rules,
   axe WCAG 2.2 AA clean on key flows.
9. CI runs dashboard lint/typecheck/unit/E2E; `npm run verify` green; security tests pass; markup tests
   replaced by equivalent behavioral tests, never deleted.
10. Merged, new UI enabled on production, smoke checks pass, rollback rehearsed, sanitized evidence on #458.
11. Dewee webchat embedded: widget bundled from npm (no CDN); handler at `/dashboard/api/v1/dewee/*` behind
    Access + session + CSRF + rate limit; gateway token server-side only; agent created/configured with
    `dewee` commands with a Cloud Harness system prompt and tools.
12. Agent controls the dashboard via client-side tools (new dewee-webchat feature: PR + npm release + tag);
    typed dashboard action registry (navigate, read state, filter, open wizard, prepare mutation);
    sensitive/destructive mutations require an explicit user click; agent never receives secrets or API keys;
    E2E proves navigate + prepare, and blocks without confirmation.
13. Dewee agent is attached to Cloud Harness MCP via the API-key lane with a **full-scope** key
    (owner decision 2026-10-20). Accepted risk: MCP-path actions bypass dashboard confirmation; control is key
    revocation. Docs/security-model record this as an owner opt-in.

## Out of scope
Removing the old shell (follow-up after rollback window); INP p75 field data; Runner/MCP/BFF rewrites;
Next.js/SSR; the separate scopes of #416, #394, #393, #421 (only re-host what exists).

## Constraints
No weakening of host/origin, CSRF, scoping, redaction. No secrets in caches/storage. Self-hosted Geist (OFL).
No force-push to main. Use an existing Dewee gateway; do not stand up a new one.

## Owner-authorized
Merge phase PRs to main (each deploys production); production cutover; dewee-webchat release.

## Defaults (overridable)
Radix primitives, React 19, Vite 7, TanStack Router file routes + Query v5, Tailwind v4, RHF + Zod, Motion only
for dialog/toast, Playwright + axe. Flag `CLOUD_HARNESS_DASHBOARD_UI=legacy|react` (default legacy until
cutover) + per-session canary `/dashboard?ui=react`. Rollback = flip to legacy + restart `api` only.
Agent name `cloud-harness-operator`. E2E uses a gateway stub per dewee-webchat `docs/http-contract.md`.
`DEWEE_WEBCHAT_SECRET` generated on host, never printed.
