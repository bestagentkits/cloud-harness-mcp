# The required `quality` check broke semantic-release, and was reverted

Date: 2026-09-21 · Repo: `bestagentkits/cloud-harness-mcp`

## What happened

Enabling `quality` as a required status check on `main` (the owner-approved remediation for the
audit's process finding) broke the release pipeline. The next push to `main` produced:

```
Release run 35583694772 (workflow_run, commit 8e8d42d) — failure
release  Create GitHub release
  stderr: 'remote: error: GH006: Protected branch update failed for refs/heads/main.
          remote: - Required status check "quality" is expected.'
  pluginName: '@semantic-release/git'
```

The cause is structural, not incidental. `.releaserc` configures `@semantic-release/git`, and
`release.yml` runs `env -u GITHUB_ACTIONS npm exec semantic-release` with
`GITHUB_TOKEN: ${{ github.token }}`. semantic-release therefore pushes a version commit
directly to `main`, and a bot push can never satisfy a required status check: the commit does
not exist until the push succeeds, so no check can have run on it. The Deploy workflows on the
same commit were unaffected (`Deploy Cloudflare Pages` = success); only Release failed.

## Why the obvious fixes do not apply here

- **Ruleset with a bypass actor** (the documented way to let a release bot push past a
  required check) is not available: creating a repository ruleset with the GitHub Actions
  integration as a bypass actor returns
  `422 Actor GitHub Actions integration must be part of the ruleset source or owner organization`,
  because this repository is user-owned rather than organization-owned.
- **An admin token for the release workflow** is not available either: the repository's
  secrets are `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `DEPLOY_SSH_KEY`,
  `VPS_HOST_KEY`, `VPS_HOST` and `VPS_USER` — there is no PAT, and `release.yml` uses
  `github.token`. Creating a personal access token is an owner action, not something this
  task can or should do.
- **Changing the release contract** (dropping `@semantic-release/git`, or pushing through a
  PR) would alter what a release means for this repository and is not a change to make
  unilaterally.

## Action taken

`main`'s branch protection was returned to its pre-enforcement state —
`required_status_checks: null`, with every other toggle preserved (`enforce_admins: false`,
no required reviews, no restrictions, no force pushes, no deletions) — so the release bot can
push again. Verification: the `Release` run for `14710a6` was watched to completion after the
revert.

## Durable options for the owner

1. **Add a release token.** Create a fine-grained PAT with `contents: write` and admin
   rights on this repository, store it as `RELEASE_TOKEN`, and use it for
   `GITHUB_TOKEN` in `release.yml`. With `enforce_admins: false`, an admin identity bypasses
   required status checks, so the `quality` gate can be re-enabled and releases keep working.
2. **Keep the gate and change the release flow.** Remove `@semantic-release/git` so
   semantic-release only tags and publishes the GitHub release, accepting that
   `package.json` versions and `CHANGELOG.md` no longer land on `main` by commit.
3. **Leave the gate off** (current state). Merges are ungated again; the audit's criterion-14
   concern remains documented rather than enforced.

This does not change the audit outcome: criterion 14 describes the phase merges that already
happened and cannot be retrofitted either way.
