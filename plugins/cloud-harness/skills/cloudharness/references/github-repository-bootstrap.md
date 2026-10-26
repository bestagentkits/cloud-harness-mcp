# GitHub repository creation and bootstrap

Create a new organization repository, then fill it through a normal workspace.
Repository creation is a separate, workspace-free tool: the repository does not
exist yet, so no workspace can be bound to it. `workspace_open` never creates a
repository; a clone failure for an unknown URL may mean the repository is private
or inaccessible, not missing.

Create a repository only when the user explicitly asked for one, with the owner,
name, and visibility they chose. Never pick `public` on your own: visibility is
required and has no default.

## Check availability first

Call `workspace_capabilities` and read `githubRepositoryCreate`. Without a
`workspaceId`, when no workspace is active, it returns only this block with
`workspaceId: null`. It never mints a token.

- `available`: true when at least one organization can be targeted.
- `organizations[]`: `login`, `administration` (`none`, `read`, `write`, or
  `null` when not yet verified), `available`, and a `reason` when unavailable.
- `personalAccounts` is always `false`: GitHub App installation tokens cannot
  create repositories on a personal user account.
- `requiredPermission` is `administration:write`. Write access to some existing
  repository does not count.

`administration: null` means the runner has not verified that installation since
it began tracking the permission. `github_repository_create` always verifies the
installation live, so it is safe to call; the result also refreshes discovery.

<!-- cloudharness-example:workspace_capabilities
{}
-->

<!-- cloudharness-tool:github_repository_create -->
### `github_repository_create`

- Required: `owner` (organization login), `name`, `visibility` (`public` or
  `private`), `idempotencyKey` (8-128 characters of `A-Z a-z 0-9 . _ : -`).
- Optional: `description` (single line, max 350), `autoInit` (initial commit
  with an empty README), `gitignoreTemplate` (for example `Node`),
  `licenseTemplate` (for example `mit`). A template creates an initial commit, so
  it cannot be combined with `autoInit: false`.
- `name` follows GitHub rules: letters, digits, `.`, `_`, `-`, at most 100
  characters, not `.`/`..`, not ending in `.git`. Other characters are refused,
  never rewritten, so `fullName` is exactly what you asked for.
- There is no `defaultBranch` input: GitHub's create API cannot set one. The
  result's `defaultBranch` is GitHub's reported default. For an empty repository
  (no `autoInit`, no template) the first branch you push becomes the default.
- Result `data`: `fullName`, `repositoryId` (immutable numeric ID; prefer it
  over the name for later identity checks), `htmlUrl`, `visibility`,
  `defaultBranch`, `created`, and `replayed`.
- Annotated destructive and not idempotent, so clients may ask for approval.

Errors (`error.code`):

| Code | Meaning | Next step |
| --- | --- | --- |
| `GITHUB_REPOSITORY_EXISTS` | The name is taken. Never treated as success. | Ask the user for another name, or `workspace_open` the existing one if that was intended. |
| `GITHUB_PERMISSION_MISSING` | The installation lacks Administration: write, or org policy refused. `requiredCapability` is `github.administration:write`. No create request was sent when the permission was missing. | Ask the owner to grant the App permission and approve the installation change. |
| `NOT_FOUND` | No installation for that organization is connected, or the organization is not visible. | Ask the owner to install and connect the App on the organization. |
| `NOT_SUPPORTED` | The owner is a personal account, no GitHub App is configured, or local mode. | Use an organization, or create the repository on github.com. |
| `GITHUB_RATE_LIMITED` | Primary or secondary rate limit. | Wait `retryAfterMs`, then retry with the same key. |
| `CONFLICT` | Same `idempotencyKey`, different input. | Use a new key for a different request. |
| `UNKNOWN_REMOTE_STATE` | The outcome could not be recorded. | Retry with the same key and input; if the name now exists, inspect it before use. |

Idempotency: the same key with the same input returns the recorded result with
`created: false, replayed: true` and no second GitHub call. The record does not
expire. A definitive GitHub refusal is not recorded, so you can retry the same
key after the owner fixes permissions.

<!-- cloudharness-example:github_repository_create
{"owner":"example-org","name":"service-starter","visibility":"private","description":"Starter service","autoInit":true,"idempotencyKey":"bootstrap:service-starter:1"}
-->

## Bootstrap composition

Only when the user explicitly asked for a new repository, run these steps in
order and track which completed:

1. `github_repository_create` with a stable `idempotencyKey`. Prefer
   `autoInit: true` (or a template) so the repository has a first commit on
   `defaultBranch` to clone. Record `repositoryId`, `fullName`, `htmlUrl`, and
   `defaultBranch`.
2. `workspace_open` on `https://github.com/<fullName>.git` with
   `ref: <defaultBranch>`.
3. `files_write_batch` or `files_write`, then `git_add`, `git_commit`, and
   `git_push` (or `workspace_finalize`) with idempotency keys.
4. Optional: `github_action` with `issue_create` for follow-up work, using an
   `idempotencyKey`.
5. `workspace_close`.

On a partial failure, stop and report exactly which steps completed and which
did not, including `fullName`, `repositoryId`, and `htmlUrl` when the repository
exists. Never delete the repository automatically and never retry creation under
a new name without the user. A retry of step 1 with the same key replays the
recorded result, so resuming the sequence is safe.
