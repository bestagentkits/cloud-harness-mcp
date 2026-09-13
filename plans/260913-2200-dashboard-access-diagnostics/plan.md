---
title: "Diagnosable Dashboard Access Rejections and Deploy Bootstrap Tolerance"
description: "Make every Cloudflare Access assertion rejection explain itself in the API log and to a browser, and keep a release startable on a host whose deploy script predates the lifecycle wrapper."
status: in-progress
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

**Status:** In Progress
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

- [ ] Each verifier rejection carries a distinct, documented reason code.
- [ ] A rejected `/dashboard` document navigation returns a 401 HTML page naming the reason;
      non-HTML clients keep `{"error":"authentication_failed"}` byte-for-byte.
- [ ] Rejection logging contains no assertion, claim, credential, or query string.
- [ ] The systemd unit starts a release whether or not the installed wrapper exists, with the
      same compose-file set (including tunnel mode) in both cases.
- [ ] Internal docs and the docs site describe the symptom, the reason codes, and recovery.
- [ ] `npm run test:unit`, `npm run lint`, and `npm run typecheck` pass (POSIX-only shell
      suites remain Linux CI-owned per `AGENTS.md`).

## Risks

- Logging must stay bounded: no token, claim values, or query strings.
- The diagnostic page must expose a reason code only, and only to a request that already
  reached the origin without a valid Access assertion.
- The unit change must not alter tunnel-mode behavior; the release script stays the single
  owner of the compose-file set.
