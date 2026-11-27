# GitHub repository discovery, creation, and bootstrap

Create a new organization repository, then fill it through a normal workspace.
Repository creation is a separate, workspace-free tool: the repository does not
exist yet, so no workspace can be bound to it. `workspace_open` never creates a
repository; a clone failure for an unknown URL may mean the repository is private
or inaccessible, not missing.

Create a repository only when the user explicitly asked for one, with the owner,
name, and visibility they chose. Never pick `public` on your own: visibility is
required and has no default.

## Discover repositories you can open

Before guessing a repository URL, or when the user asks which repositories are
available, list them. Check this list before concluding that a repository is
missing.

<!-- cloudharness-tool:github_repositories_list -->
### `github_repositories_list`

- Not bound to a workspace; read-only, so no approval prompt. Never returns a
  token.
- Lists the repositories the principal can open across its personal account and
  organizations, read live from GitHub, in the order credentials are tried:
  `via: "installation"` (GitHub App installations bound to this identity; each
  call re-verifies them and refreshes the stored grants), then `via: "user"`
  (installations of the App the person's connected GitHub user can reach).
- While a GitHub user is connected, only repositories that user can access are
  listed, and `access` is capped at the user's permission. If the user's access
  cannot be read, nothing is listed and `warnings` says why.
- Each repository: `fullName`, `repositoryUrl` (pass it to `workspace_open`),
  `access` (`write` is the permission `git_push` needs, not a guarantee;
  archived ones the user listing reports are `read`), `via`, and when known `private`,
  `archived`, `defaultBranch`.
- `unreachableAccounts`: the person's own account and public organization
  memberships that no App installation reachable by them covers.
  `installation: "installed"` means the App is there but they have no access:
  tell them to ask an owner for access. `installation: "unknown"` may mean the
  App is not installed (`installUrl` when present). Public repositories still
  clone. Private memberships are invisible to the App, so absence from this
  list proves nothing.
- Inputs: optional `owner`, `query` (substring of `owner/name`), `cursor` and
  `limit` (1-500, default 200; page while `truncated` is true), and `refresh`
  to bypass the 60-second cache.
- A failing account becomes a `warnings` entry instead of an error (stored
  grants stand in, `accounts[].live: false`); `incomplete: true` means some
  repositories are missing. Read `warnings` before answering "not available".
- `NOT_SUPPORTED`: no GitHub App is configured, or local mode.

<!-- cloudharness-example:github_repositories_list
{"owner":"example-org","query":"service","limit":50}
-->

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
The same holds when `available` is false with a `reason` saying the configured
installation is verified live on use: an operator-configured installation with
no dashboard connection is only checked by the call itself, so call it rather
than giving up. A stored record can also be stale, for example after the owner
granted the permission or unsuspended the App, so a refusal from the call is
the authoritative answer, not the discovery block.

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
