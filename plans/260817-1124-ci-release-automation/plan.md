---
title: "CI release automation"
description: "Release GitHub beta and stable versions from Conventional Commit history after the existing CI gate."
status: pending
priority: P1
effort: 4h
branch: main
tags: [infra, ci, release]
blockedBy: []
blocks: []
created: 2026-08-17
---

# CI release automation

## Overview

Add GitHub-only SemVer releases. A successful push CI on `dev` publishes a
`beta` prerelease; a successful push CI on `main` publishes a stable release.
Conventional Commit history determines the version and GitHub Release notes.
No npm publishing is in scope; the release bot commits synchronized workspace
and runtime version metadata plus the generated changelog.

## Prerequisite decision

The repository has no SemVer tag/release; `main` and all workspace manifests
currently say `0.2.0` at `1f472830844d484095e14bef32c4fd34c8a09db1`.

- Preferred: owner creates immutable annotated `v0.2.0` and matching GitHub
  Release at that exact commit before enabling automation. The next eligible
  change then becomes `0.2.1`, `0.3.0`, or `1.0.0` as appropriate.
- Alternative: explicitly accept semantic-release's first published version
  from the whole history (normally `1.0.0` for this history). Do not enable the
  workflow until this choice is recorded.

Also create and protect `dev` from the release-enabled `main` tip; it does not
exist remotely today. Protect `main` and `dev` against direct unreviewed
changes because either branch can create public releases.

## Release flow

```text
push dev/main -> CI (quality -> docker integration) -> Release
dev  + eligible Conventional Commit -> vX.Y.Z-beta.N GitHub prerelease
main + eligible Conventional Commit -> vX.Y.Z GitHub stable release
main successful CI -> existing production deploy (unchanged)
```

`docs`, `chore`, merge-only, and other non-eligible commits produce neither a
new version nor a new GitHub Release. The existing production rule remains
unchanged: every successful `main` CI remains eligible to deploy its tested
SHA, including a non-release change.

## Phases

| Phase | Name | Status |
|---|---|---|
| 1 | [Configure and verify release automation](./phase-01-configure-and-verify-release-automation.md) | Pending |

## Acceptance criteria

- [ ] `dev` publishes `vX.Y.Z-beta.N` only after successful CI for its exact source tip.
- [ ] `main` publishes `vX.Y.Z` only after successful CI for its exact source tip.
- [ ] GitHub Releases and `CHANGELOG.md` contain generated Conventional Commit notes; no npm publish occurs.
- [ ] `contents: write` is granted only to the release job/workflow and no release write occurs on PRs.
- [ ] Existing `main` production deployment remains CI-gated and deploys the exact tested SHA.

## Open questions

- Confirm the preferred `v0.2.0` baseline tag/release, or authorize an initial `1.0.0`.
- None.
