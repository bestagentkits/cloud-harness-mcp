---
phase: 2
title: "Dashboard BFF and accessible workspace UI"
status: completed
priority: P1
effort: "2-3d"
dependencies: [1]
---

# Dashboard BFF and accessible workspace UI

## Overview

Add a same-origin browser BFF and accessible dashboard for workspace/project lifecycle, current task/session state, resource limits, repositories, bounded artifacts, and guarded file operations.

## Requirements

- Expose `/dashboard` and `/dashboard/api/v1/*` only in `cloudflare-access` mode and protect them with the same principal resolver as `/mcp`; return disabled/not-found in bearer mode.
- Reuse runner/Zod contracts for list/read/write/patch/move/mkdir/delete/close; expose no exec, shell, deployment, host path, or Docker surface.
- Require exact Host/Origin, JSON mutation bodies, per-session CSRF, `no-store`, CSP/nosniff/frame protections, and bounded input/output.
- Use SHA/ETag preconditions for files and generation preconditions for metadata mutations.
- Use a generation-fenced internal close operation; do not reuse unconditional public `workspace_close` for stale dashboard tabs.
- Provide keyboard/focus-safe navigation, loading/empty/error/expired states, destructive confirmation, and redaction indicators.

## Architecture

Static dashboard assets are served by the API origin behind Access. Narrow BFF endpoints pass only the verified request-local external identity to a service-authenticated runner call; the runner resolves its opaque principal transactionally before executing the operation. Public marketing `site/` remains credential-free and unchanged.

## Related code files

- Create focused dashboard router, CSRF/session, response mapping, and static asset modules under `apps/api/`
- Modify `apps/api/src/app.ts` and build/Docker asset-copy rules as required
- Add dashboard API/auth/CSRF and UI contract tests under `apps/api/test/`

## TDD implementation steps

1. Test bootstrap, workspace list/status/close, current task/session status, repository/project/artifact summary, and bounded file mappings.
2. Test CSRF/origin/content-type/body-limit/ETag and sanitized unauthenticated/foreign failures.
3. Test semantic landmarks, keyboard navigation, focus return, reduced motion, empty/error/expired states, and destructive confirmation.
4. Test that bearer mode exposes no dashboard login/session path and that concurrent close/touch/reaper/file operations fence stale generations.
5. Implement small BFF modules and static assets within repository size guidance.
6. Scan responses/HTML/JS/storage surfaces for bearer, Access assertion, runner token, provider credential, or secret value.
7. Run focused API/UI checks and `npm run verify`.

## Success criteria

- [x] Users inspect and operate only their resources through bounded existing contracts.
- [x] File conflict and expired-resource states are explicit and recoverable.
- [x] Browser cannot receive credentials or select a principal.
- [x] Dashboard works with keyboard, narrow viewport, and reduced motion.

## Risk and rollback

Keep assets immutable and BFF routes narrow; dashboard routing can be disabled without changing `/mcp`. If same-origin cannot be preserved under the Access hostname, stop rather than weaken CORS/CSRF.
