---
title: Cloudflare Access dashboard ship validation
date: 2026-08-17
summary: "Issues #13/#18 reached merged-head code and image verification; PR, Docker tests, and live Cloudflare rollout remain open."
---

# Cloudflare Access dashboard ship validation

Issues: #13, #18
Branch: `codex/feat/cloudflare-oauth-dashboard`
Work plan: [`Cloudflare OAuth principal model and dashboard`](../260817-1321-13-cloudflare-oauth-dashboard/plan.md)

## Chronology

1. The work was scoped as an opt-in `cloudflare-access` mode. Cloudflare Access Managed OAuth supplies GitHub or Google SSO and a normalized `(issuer, subject)` identity; Cloud Harness remains responsible for principal authorization. Existing private deployments keep `owner-bearer` as the default. The dashboard is unavailable in bearer mode, and the shared-kernel executor remains limited to one owner or mutually trusted operators rather than hostile multi-tenancy.

2. Principal-scoped API, runner, state, and dashboard paths were implemented. Authorization occurs before resource lookup, foreign and unknown handles share the same denial behavior, and the browser-facing BFF reuses bounded runner operations without exposing execution bearer tokens, Access assertions, runner credentials, privileged terminal access, or a second executor path.

3. The runner gained the #18 control surfaces: project/environment metadata, write-only encrypted secrets with a runner-held versioned AEAD keyring, explicit selection of user-owned environment values for new workspaces, principal-bound GitHub App installation/repository binding with server-side verification, bounded artifact snapshots, and audit summaries. GitHub SSO identifies the operator; GitHub App credentials remain the repository authorization boundary and stay runner-confined.

4. Deployment and rollback paths were hardened. Runtime and canary secrets were separated, Compose boundary checks retained credential-free ingress as the only host-published service, and rollback now fails closed on incomplete quiescence. Forward deploy and rollback verify immutable image identity before recording a release, and failure containment short-circuits subsequent transitions.

5. The feature implementation was committed as `3b1b455` (`feat(auth): add Cloudflare Access dashboard`) at 19:32 +07:00. The feature branch then incorporated current `origin/main` in local merge commit `5118eec` at 19:33 +07:00. This merge commit is a synchronization commit on the feature branch; it is not evidence that the feature was merged to the upstream default branch.

6. The merged-head non-Docker verification passed: 41 test files and 206 tests. Focused rollback verification passed 16 tests, Compose boundary verification and shell syntax checks passed, and final code review returned GO for code ship. That review explicitly did not establish Docker/e2e, Cloudflare, IdP, public-edge canary, destructive rollback rehearsal, production deployment, or customer rollout evidence.

7. No pull request has been opened for `codex/feat/cloudflare-oauth-dashboard`. The merged-head executor, API, and runner images built successfully. Docker tests then hit shared-daemon no-space and lock contention while another worktree was building the same image set. Approved unused build-cache cleanup restored volume creation, but a second test attempt collided with that active build and timed out in Docker setup. Hosted exact-head CI on a clean runner remains the next independent gate.

## Current state

Code for issues #13/#18 is present on the feature branch at `5118eec`, with feature commit `3b1b455`, passing merged-head non-Docker verification, and successful production image builds. PR creation, hosted exact-head CI, clean Docker-backed verification, and any merge to the default branch remain outstanding. Cloudflare Access application/hostname policy, GitHub and Google IdPs, client discovery/login/refresh/revocation, cross-principal denial, public-edge canary, rollback rehearsal, promotion, and production verification also remain owner-operated live rollout gates.

This record does not claim that the feature is shipped, deployed, or live.

## Unresolved questions

- Will hosted exact-head CI reproduce the local Docker setup timeouts on its clean runner?
- Which eligible Cloudflare hostname, Access policy, trusted-operator allowlist, and GitHub/Google IdP configuration will be used for the owner-authorized live rollout?
- When will the sanitized public-edge canary, revocation, cross-principal denial, rollback-after-write rehearsal, and exact deployed-SHA verification be run?

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
