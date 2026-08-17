---
phase: 1
title: "Configure and verify release automation"
status: pending
priority: P1
effort: 4h
dependencies: []
---

# Phase 1: Configure and verify release automation

## Context links

- [`CI`](../../.github/workflows/ci.yml) — current quality and Docker gate.
- [`production deploy`](../../.github/workflows/deploy.yml) — deploys only a successful `main` CI SHA.
- [`Development`](../../docs/development.md) and [`Deployment`](../../docs/deployment.md).

## Overview

Make CI cover `dev` and `main`, then run a separate GitHub-only release
workflow after that CI completes successfully. Release state is Git tag plus
GitHub Release, with a release commit that synchronizes the changelog,
workspace manifests, lockfile, and MCP runtime version.

## Requirements

- Analyze Conventional Commits: `fix`/`perf` -> patch, `feat` -> minor, and
  `!` or `BREAKING CHANGE` -> major. Ignore types without a release rule.
- Configure branches in semantic-release order: `main`, then `dev` with
  `prerelease: beta` and `channel: beta`; use `v${version}` tags.
- Produce generated release notes in GitHub Releases and `CHANGELOG.md`. Mark
  `dev` releases as prereleases and `main` releases as stable. Do not publish
  to npm.
- Release only on `workflow_run` success from CI for `main` or `dev`; never
  release from `pull_request`, fork code, or a manually supplied SHA.
- Before releasing, fetch full history/tags and assert the CI `head_sha` still
  equals `origin/<head_branch>`; skip stale CI instead of generating metadata
  from an old source tip.

## Architecture

1. `.github/workflows/ci.yml` accepts pushes to both `main` and `dev`; its
   existing job order and read-only permissions remain unchanged.
2. New `release.yml` listens for completed `CI` workflow runs, checks success,
   branch and exact tip, switches to that local branch, then disables GitHub
   event detection only for the semantic-release child process so it selects
   the checked-out branch rather than workflow-run's default-branch ref.
3. `semantic-release` calculates the version, updates changelog/runtime
   metadata, commits it, then tags and creates the GitHub Release. CI has
   verified the preceding source commit; the tag points at its generated
   metadata commit. Branch concurrency is `release-<branch>` with cancellation
   disabled so a tag/release is never interrupted halfway through.
4. `deploy.yml` remains triggered by successful `CI` on `main`; it still uses
   its protected environment and fixed SSH/SHA contract. Release and deploy may
   run concurrently after CI; do not make production deployment depend on a
   release because that would change its existing behavior for no-release docs
   or chore commits.

## Related code files

- Modify: `.github/workflows/ci.yml` — add `dev` push trigger only.
- Create: `.github/workflows/release.yml` — CI-success release workflow.
- Create: `.releaserc.json`, `scripts/update-release-version.mjs`, and `CHANGELOG.md` — release configuration, metadata synchronization, and generated notes.
- Modify: `package.json`, `package-lock.json`, workspace manifests, and `apps/api/src/mcp-server.ts` — pinned release-only dependencies and release-version metadata.
- Modify: `docs/development.md` — Conventional Commit and beta/stable release contract.
- Modify: `docs/deployment.md` — distinguish CI-gated deployment from GitHub release publication.
- Do not modify: `.github/workflows/deploy.yml`.

## Implementation steps

1. Resolve the baseline prerequisite. Create/publish the owner-approved
   immutable baseline or record acceptance of the initial `1.0.0`; create `dev`
   from the release-enabled main commit and configure required checks/protection.
2. Add semantic-release plus Conventional Commit, changelog, version-sync,
   Git, and GitHub plugins. Lock them with npm. Do not add the npm plugin or
   registry tokens.
3. Add `.releaserc.json` with the explicit branch contract and plugin list.
   Generate `CHANGELOG.md`, synchronize package/runtime versions, and commit
   only those release artifacts before tagging.
4. Extend CI push filtering to `main` and `dev`, retaining pull-request CI and
   `contents: read`.
5. Add the release workflow. Use pinned checkout/setup-node actions, `npm ci`,
   `fetch-depth: 0`, branch-tip/local-branch verification, `GITHUB_TOKEN`, and
   the minimum `contents: write` permission. Invoke semantic-release without
   `GITHUB_ACTIONS` so generic CI detection uses the checked-out local branch.
   Give the workflow an independent, non-cancelling per-branch concurrency
   group.
6. Confirm the repository/organization Actions policy allows a workflow-level
   explicit `contents: write`; the current default token permission is read
   only. Do not introduce a PAT unless this explicit permission is blocked.
7. Update docs with release precedence: CI success proves test status; a tag and
   GitHub Release prove publication; the existing deploy receipt proves VPS
   rollout. Keep production secrets and environment approvals unchanged.

## Todo list

- [ ] Baseline and branch-protection decision recorded.
- [ ] Release dependencies/config added and lockfile refreshed.
- [ ] CI and release event/permission/concurrency rules implemented.
- [ ] Documentation updated.
- [ ] Dry-run and live beta-to-stable promotion validated.

## Success criteria

- [ ] `fix:` on `dev` creates a beta tag/release; a subsequent merge to `main`
  creates the equivalent stable tag/release after `main` CI.
- [ ] `feat:` and breaking-change scenarios choose minor and major respectively.
- [ ] Non-release commits create no release; existing successful-main deployment
  behavior remains unchanged.
- [ ] A stale completed CI run cannot tag a non-tip commit.
- [ ] `npm run verify` passes after dependency/config changes; a semantic-release
  dry-run verifies analysis without publication before the first real beta.

## Risk assessment

- No baseline tag causes an unintended first `1.0.0`. Signal: dry-run reports
  an initial major release. Response: stop and seed/approve the baseline.
- A protected/organization policy may deny release writes. Signal: GitHub API
  returns 403. Response: allow explicit `contents: write`; do not add a PAT by default.
- A new push can make a completed CI stale. Signal: CI head differs from branch
  tip. Response: skip it; the later CI run owns publication.
- A public repository makes release notes and tags public. Signal: repository
  visibility remains public. Response: confirm visibility before tagging;
  redact no private operational data into commits or release notes.

## Security considerations

- Grant `contents: write` only to the release workflow. CI and deploy retain
  their existing least privileges.
- Do not run release publishing against pull-request code or pass secrets to
  PR-triggered jobs. `workflow_run` checks the trusted CI completion and then
  verifies the exact branch tip.
- Use only `GITHUB_TOKEN`; no registry, PAT, or deployment secret is required
  for GitHub Releases.

## Next steps

After the prerequisite decision, implement on a branch, test a `dev` beta,
then merge the same change into `main` and verify tag, release, CI, and the
separate production-deploy receipt.
