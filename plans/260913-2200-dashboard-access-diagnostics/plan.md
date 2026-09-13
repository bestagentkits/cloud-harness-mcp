---
title: "Diagnosable Dashboard Access Rejections and Deploy Bootstrap Tolerance"
description: "Make every Cloudflare Access assertion rejection explain itself in the API log and to a browser, and keep a release startable on a host whose deploy script predates the lifecycle wrapper."
status: completed
priority: P1
effort: 1d
issue: 176
branch: mrgoonie/fix-github-auth-issue
tags: [bugfix, auth, dashboard, deploy, observability]
blockedBy: []
blocks: []
created: 2026-09-13
---

# Plan: Diagnosable Dashboard Access Rejections and Deploy Bootstrap Tolerance

**Status:** Completed
**Date:** 2026-09-13
**Slug:** `260913-2200-dashboard-access-diagnostics`
**Route:** bugfix

## Executive Summary

Reported symptom: `https://harness.zuey.me/dashboard` answered an authenticated browser
session with `{"error":"authentication_failed"}`, so the Cloudflare Access login looked
broken.

Live investigation (owner-authorized; read-only except one loopback capture) established:

1. The deployed API ran the assertion path unchanged from `main` and its effective
   configuration matched the live Access application: `CLOUDFLARE_ACCESS_AUDIENCE` equaled
   the live application AUD tag, and the issuer/JWKS URL equaled the live team domain. JWKS
   was reachable from the API container, the key document parsed, and the host clock was
   correct.
2. The failing browser request reached the origin through Cloudflare and was rejected by
   `accessAssertionAuth`, which answered `401 authentication_failed` for both "no assertion"
   and "assertion failed verification".
3. The same browser assertion that was rejected at 12:04 UTC verified successfully at
   12:44 UTC after the owner re-scoped the Access application. The origin behaved correctly;
   the incident was an edge application-configuration window.
4. The failure was undiagnosable in production: `CloudflareAccessJwtVerifier` collapsed every
   rejection into one message, `auth.ts` swallowed it (`catch {}`), the API logged nothing,
   and a browser document request received bare JSON. Diagnosis required instrumenting the
   live host with a packet capture.
5. Independent blocker: production is frozen on release `a869ea6c` because every deploy since
   2026-08-31 fails — the installed systemd unit runs
   `/usr/local/sbin/cloud-harness-service-compose`, which the on-host (pre-wrapper) deploy
   script never installs.

## Phases and Links

- [Phase 1: Failure classification](phase-01-failure-classification.md)
- [Phase 2: Operator and browser diagnostics](phase-02-operator-and-browser-diagnostics.md)
- [Phase 3: Deploy bootstrap tolerance](phase-03-deploy-bootstrap-tolerance.md)
- [Phase 4: Documentation](phase-04-documentation.md)
- [Phase 5: Verification](phase-05-verification.md)

## Acceptance Criteria

- [x] Each verifier rejection carries a distinct, documented reason code.
- [x] A rejected `/dashboard` document navigation returns a 401 HTML page naming the reason;
      non-HTML clients keep `{"error":"authentication_failed"}` byte-for-byte.
- [x] Rejection logging contains no assertion, claim, credential, or query string.
- [x] The systemd unit starts a release whether or not the installed wrapper exists, with the
      same compose-file set (including tunnel mode) in both cases.
- [x] Internal docs and the docs site describe the symptom, the reason codes, and recovery.
- [x] `npm run test:unit`, `npm run lint`, and `npm run typecheck` pass (POSIX-only shell
      suites remain Linux CI-owned per `AGENTS.md`).

## Risks

- Logging must stay bounded: no token, claim values, or query strings.
- The diagnostic page must expose a reason code only, and only to a request that already
  reached the origin without a valid Access assertion.
- The unit change must not alter tunnel-mode behavior; the release script stays the single
  owner of the compose-file set.

## Outcome (verified)

Shipped in `#177` (`eb9907b`), `#179` (`9f2d634`), and `#183` (`7b7e220`); the reviewed
follow-ups landed because the round-one review found four defects (HTML negotiation on the
MCP lanes, JWKS body-stream failures mislabelled, negative-cache hits losing the outage
reason, missing mount prefix in the logged path) and the advisory review found the
negative-cache gate that still delayed recovery under a burst.

Live verification on production (`v0.39.4`, release `c58b328`):

- A browser-shaped document request that reaches the origin without an Access assertion
  returns `401 text/html` with `Content-Security-Policy: default-src 'none'; base-uri 'none';
  frame-ancestors 'none'` and the page names `missing_assertion`.
- The API logs the matching bounded line —
  `{"level":40,…,"reason":"missing_assertion","method":"GET","path":"/dashboard","host":"harness.zuey.me","msg":"access assertion rejected"}`
  — with the mount prefix preserved and no assertion, claim, or query string.

The deploy half of this plan was forward hardening only; the two-week freeze was repaired
separately by the owner through host bootstrap work recorded in `#181` (stale launcher with a
three-image build list, missing `agent`/`network-guard`/`model-gateway` images and
model-gateway configuration, a legacy `WORKSPACE_NETWORK_MODE` value, a wedged BuildKit
cache, and a canary sending the removed `networkMode` argument). Deploys `48fc3409` and
`c58b3284` are green and production runs `c58b328`.
