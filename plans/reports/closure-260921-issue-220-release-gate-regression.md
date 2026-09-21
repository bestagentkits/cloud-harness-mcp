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

## Resolution

Option 1 was taken. The owner supplied `RELEASE_TOKEN` (a classic PAT whose owner holds
admin on this repository), it is stored as a repository secret, and `release.yml` now passes
`secrets.RELEASE_TOKEN || github.token` to both `actions/checkout` — which persists the
credential the git push actually uses — and the semantic-release step, keeping the default
token as a fallback so the workflow still runs when the secret is absent. PR #248 carried that
change and was merged only after its own required `quality` check passed.

The required check was then re-enabled on `main` (`required_status_checks.contexts = ["quality"]`,
`strict: false`, `enforce_admins: false`, every other toggle preserved). The bypass that makes
this safe was verified by configuration rather than by breaking releases to test it: the token's
owner reports `admin: true` on this repository, the token carries the `repo` scope, and with
`enforce_admins: false` GitHub lets an admin identity bypass required status checks — which is
exactly the identity the release bot now pushes with.

Ordering was learned the hard way. The gate was briefly enabled before the token-aware
workflow reached `main`, which would have blocked the release bot's push, so the check was
reverted until #248 landed and then re-applied. No release was lost in that window: `0.55.1`
had already been published from `a94708d` while the gate was off, and the `Release` run for
`f8a7d9b` had nothing to publish and completed `success`.

## Alternatives considered

1. **Drop `@semantic-release/git`** so semantic-release only tags and publishes the GitHub
   release. Rejected: `package.json` versions and `CHANGELOG.md` would stop landing on `main`
   by commit, changing what a release means for this repository.
2. **Leave the gate off.** Rejected by the owner: merges would stay ungated, leaving the
   audit's criterion-14 concern documented rather than enforced.

This does not change the audit outcome for criterion 14. The phase merges happened before any
required check existed and cannot be retrofitted. It does mean the repository now enforces the
gate that criterion asked for, for every merge from here on.

This does not change the audit outcome: criterion 14 describes the phase merges that already
happened and cannot be retrofitted either way.
