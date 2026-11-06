---
title: GitHub App Configuration Guide
description: Step-by-step instructions for configuring a GitHub App for private repository cloning and credential-isolated Git push.
---

# GitHub App Configuration Guide

Cloud Harness MCP uses a **GitHub App integration** to clone private repositories and execute origin-only pushes (`git_push`) without storing long-lived personal access tokens or SSH private keys inside container environments.

A GitHub App is **optional**. Without one, GitHub operations resolve an operator-supplied fallback credential instead: `GH_TOKEN` then `GITHUB_TOKEN` from the runner environment (owner-bearer mode only), or a global runtime secret named `GH_TOKEN`/`GITHUB_TOKEN` held by the requesting principal. See [GitHub credential fallback](#github-credential-fallback) below.

---

## GitHub credential fallback

Use this when you want GitHub operations without registering a GitHub App.

Resolution order for `github_action` and private Git operations (clone, fetch, pull, push):

1. A GitHub App repository-scoped token, when an App is configured and authorized.
2. `GH_TOKEN`, then `GITHUB_TOKEN`, from the **runner process environment** (each also accepting a `_FILE` form). This source is honored **only** in `owner-bearer` mode.
3. An active **global runtime secret** named `GH_TOKEN`, then `GITHUB_TOKEN`, held by the requesting principal.

In `cloudflare-access` mode step 2 is refused entirely: a single operator-wide credential must never stand in for a different principal's App grant. Use step 3 there.

Setting the runner environment credential:

```bash
# In the runner's environment file (e.g. .env). Read GH_TOKEN first, then GITHUB_TOKEN.
GH_TOKEN=github_pat_...
```

Or create it in the dashboard under **Secrets**, which requires no restart and is scoped per principal.

**Behavior notes:**

- A value that cannot be a GitHub credential (shorter than 20 characters, or containing whitespace) is ignored rather than sent to GitHub.
- Resolved credentials are passed over `stdin` to ephemeral helpers and are registered with the ingest-time redactor. They are never written to results, logs, audit payloads, or the Git remote.
- `workspace_capabilities` reports GitHub read/write capability when either an App or a fallback credential is available.
- A personal access token is **not** repository-scoped and cannot be limited by an installation grant. Prefer a GitHub App, or the narrowest fine-grained token.
- `GH_TOKEN` shadows `GITHUB_TOKEN`: only the first usable name is sent. A fine-grained token covers a single resource owner, and one pending organization approval is refused with a 403.
- If a clone with a fallback credential fails and you have an installation on the repository owner, the runner reconciles it and retries once with an App token. Clone errors name the credential source (`github-app`, `principal-global-secret`, `runner-environment`, `none`), never the token.
- The environment credential authenticates **harness-side** operations only; it is never placed in an executor environment. To authenticate the workspace's own `gh` CLI, create a global runtime secret named `GH_TOKEN`/`GITHUB_TOKEN` (see [Secrets & Credentials](secrets.md#github-credentials-in-workspaces)).

---

## How It Works

```
[ AI Agent in Executor Container ]
                │
                │ 1. Calls git_push / workspace_open
                ▼
[ Trusted Runner Daemon ]
                │ 2. Exchanges App Private Key for a 10-minute repository token
                ▼
[ GitHub App Broker ] ──(token over STDIN)──► [ Ephemeral Git Helper ]
                                                       │
                                                       │ 3. Pushes to github.com
                                                       ▼
                                            [ GitHub Private Repo ]
```

- **Ephemeral Access:** The token is valid for only 10 minutes and strictly scoped to the repository being operated on.
- **Never Saved to Disk:** The token is streamed over `stdin` directly into Git's credential helper and is never written to `.git/config` or workspace files.
- **Executor Confinement:** The container running your agent code has zero access to the GitHub App private key or control-plane credentials.

---

## Step 1: Decide Required Permissions

Before creating the App in GitHub, choose the minimum required permission level:

| Goal | Required Permission |
| --- | --- |
| **Clone, fetch, and pull private repos** | **Contents: Read-only** |
| **Push ordinary code & branch commits** | **Contents: Read and write** |
| **Push CI/CD workflows (`.github/workflows/`)** | **Contents: Read and write** + **Workflows: Read and write** |
| **Read issues and pull requests through `github_read`/`github_action`** | **Issues: Read-only** + **Pull requests: Read-only** + **Contents: Read-only** |
| **Create or update issues and pull requests through `github_action`** | **Issues: Read and write** + **Pull requests: Read and write** + **Contents: Read-only** |
| **Review pull requests (reviews, inline comments, threads, reviewers, draft/ready)** | **Pull requests: Read and write** + **Contents: Read-only** |
| **Merge pull requests or enable auto-merge** | **Pull requests: Read and write** + **Contents: Read and write** |
| **List/compare commits, releases, and tags through `github_read`/`github_action`** | **Contents: Read-only** |
| **Read or post commit statuses (`commit_status_get`, `commit_status_create`)** | **Commit statuses: Read-only** or **Read and write** + **Contents: Read-only** |
| **List check runs for a commit (`check_runs_list`)** | **Checks: Read-only** + **Contents: Read-only** |
| **Read workflow runs, dispatch workflows, re-run failed jobs** | **Actions: Read-only** or **Read and write** + **Contents: Read-only** |
| **Use a branch as a merge-train lock (`git_push` leases)** | **Contents: Read and write** |
| **Create organization repositories (`github_repository_create`)** | **Administration: Read and write** (organization installation only) |

::: warning Installation without Contents
An installation lacking the **Contents** permission lists no readable repositories, mints no token for clones, and `workspace_capabilities` reports `repositoryAccessReason`: "GitHub App installation lacks the Contents permission; an owner must approve it". Approve the permission request, then reconcile.
:::

::: tip Principle of Least Privilege
Leave every other repository, organization, and user permission set to **No access**.
:::

`github_action` always carries **Contents: Read-only** on its token, because `gh`
resolves repository metadata over the GraphQL API; an App that grants only the
issue and pull-request permissions cannot mint an action-scoped token.

---

## Step 2: Register the GitHub App

1. Open your GitHub account:
   - For a personal account: Go to [github.com/settings/apps](https://github.com/settings/apps).
   - For an organization: Go to `https://github.com/organizations/<YOUR_ORG>/settings/apps`.
2. Click **New GitHub App**.
3. Fill in the basic details:
   - **GitHub App name:** `Cloud-Harness-<YourName>` (must be globally unique across GitHub).
   - **Homepage URL:** `https://harness.agentkit.best` (or your repository URL).
   - **Callback URL:** `https://<your-dashboard-domain>/dashboard/integrations/github`. The
     dashboard asks you to authorize with GitHub before it connects an installation, and
     GitHub only returns to a registered Callback URL. Leave **Request user authorization
     (OAuth) during installation** unchecked.
   - **Setup URL:** the same `https://<your-dashboard-domain>/dashboard/integrations/github`,
     and check **Redirect on update**. GitHub returns to the Setup URL after a new installation;
     **Redirect on update** also returns there after you change an existing installation, which
     is how an account that already has the App installed gets connected (GitHub opens
     **Configure** instead of **Install** for it). An App registered earlier with
     `/dashboard/github` still works; that path redirects here and keeps the setup callback
     parameters.
4. **Webhook:**
   - Uncheck **Active** under the Webhook section (Cloud Harness does not require webhooks).
5. **Repository permissions:**
   - Set **Contents** to **Read and write** (or Read-only).
   - (Optional) Set **Workflows** to **Read and write** if your agents need to edit GitHub Actions.
   - (Optional) Set **Commit statuses**, **Checks**, or **Actions** when an automated routine posts statuses, reads check runs, or dispatches and re-runs workflows.
   - For an App that organizations connect from the dashboard, set **Organization permissions → Members** to **Read-only**. GitHub needs it to confirm that the person connecting is an organization owner.
6. **Where can this GitHub App be installed?:**
   - Select **Only on this account**.
7. Click **Create GitHub App**.

---

## Step 3: Download Private Key & Note IDs

After creating the App:

1. **App ID:** Copy the numeric **App ID** displayed at the top of the General settings page (e.g. `123456`).
2. **App Slug / Name:** Note the URL slug of your app (e.g. `cloud-harness-operator`).
3. **Client ID and client secret** (needed to connect installations from the dashboard): copy the
   **Client ID**, then click **Generate a new client secret** and save the value; GitHub shows it once.
4. **Generate Private Key:**
   - Scroll down to the **Private keys** section.
   - Click **Generate a private key**.
   - A `.pem` file will automatically download to your machine. Keep this file secure; GitHub does not store it.

---

## Step 4: Install App on Selected Repositories

1. In your GitHub App settings, click **Install App** in the left sidebar.
2. Click **Install** next to your account or organization.
3. Choose **Only select repositories**.
4. Select the private repositories you want Cloud Harness agents to access.
5. Click **Install**.
6. After installation, GitHub redirects to a settings page URL such as:

   ```text
   https://github.com/settings/installations/78901234
   ```

   The trailing number (`78901234`) is your **Installation ID**.

---

## Step 5: Configure the Server Environment

On your Cloud Harness production server or VPS:

### 1. Secure the Private Key File

Place the downloaded `.pem` file on the host filesystem with strict root permissions:

```bash
sudo install -d -m 700 -o root -g root /etc/cloud-harness-mcp
sudo install -m 600 -o root -g root /path/to/downloaded-key.pem /etc/cloud-harness-mcp/github-app-private-key.pem
```

For dashboard connections, store the client secret the same way, without echoing it:

```bash
sudo install -m 600 -o root -g root /dev/null /etc/cloud-harness-mcp/github-app-client-secret
sudoedit /etc/cloud-harness-mcp/github-app-client-secret
```

### 2. Update Environment Variables (`.env`)

In your server's `.env` or `/etc/cloud-harness-mcp/runtime.env`:

```dotenv
# Your numeric GitHub App ID
GITHUB_APP_ID=123456

# In owner-bearer mode: provide the numeric installation ID
GITHUB_APP_INSTALLATION_ID=78901234

# In cloudflare-access or oidc mode: provide the app slug for dashboard linking
GITHUB_APP_SLUG=cloud-harness-operator

# In cloudflare-access or oidc mode: the App's OAuth client, used to prove that the
# GitHub user connecting an installation owns it (runner-only)
GITHUB_APP_CLIENT_ID=Iv23exampleclientid
GITHUB_APP_CLIENT_SECRET_FILE=/run/cloud-harness-secrets/github-app-client-secret

# Container mount path to the private key (inside the runner)
GITHUB_APP_PRIVATE_KEY_FILE=/run/cloud-harness-secrets/github-app-private-key.pem
```

### 3. Restart the Runner

Restart containers so the runner picks up the new configuration:

```bash
docker compose down && docker compose up -d
```

---

## Step 6: Connect in Operator Dashboard

1. Open the Operator Dashboard at `https://<your-dashboard-domain>/dashboard`.
2. Navigate to **Integrations → GitHub**.
3. Click **Connect GitHub App** and finish within 10 minutes:
   - **App not installed yet:** GitHub shows **Install**. Choose the repositories and install;
     GitHub returns to the dashboard, which sends you straight on to authorize with GitHub.
   - **App already installed on that account:** GitHub shows **Configure**. Save the
     installation; GitHub returns with the installation ID only, and the dashboard shows
     **Verify with GitHub**. Click it.
4. Authorize the App on GitHub **as the account that owns the installation**: the personal
   account itself, or an owner of the organization. Organization members who are not owners
   are refused. The dashboard then shows the installation and its repositories.

GitHub only proves who you are here; the user token is used once on the server, revoked at
GitHub right after, and never stored or shown. If the operator has not set
`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`, **Connect GitHub App** and **Verify
with GitHub** are disabled and the page says so. If this identity already has the
installation, returning from **Configure** just refreshes it. If the installation was bound
earlier to a different Cloud Harness identity (older releases did not verify ownership),
authorizing as the account owner or an organization owner moves it to you; the previous
identity loses it and the audit log records the change.

---

## Step 7: Verify Private Repository Access

Test opening a private repository through your AI client (Cursor, Claude Code, etc.):

```json
// Tool: workspace_open
{
  "repositoryUrl": "https://github.com/my-org/private-repo.git",
  "idempotencyKey": "test-github-app-01"
}
```

- Confirm `workspace_status` returns `status: "ready"`.
- Test committing and pushing on a disposable branch:

  ```json
  // Tool: git_push
  {
    "workspaceId": "ws_...",
    "refspec": "HEAD:refs/heads/feature/test-branch"
  }
  ```

---

## Troubleshooting

| Issue | Cause | Resolution |
| --- | --- | --- |
| **`Repository clone failed: unauthorized (404/401)`** | Repository not selected in GitHub App installation. | Go to [github.com/settings/installations](https://github.com/settings/installations), click **Configure** on your App, and add the repository to **Repository access**. |
| **`Push failed: 403 Forbidden`** | App has Read-only permissions for `Contents`. | In App settings → **Permissions**, change **Contents** to **Read and write**. Then accept the permission update under your installation settings. |
| **`Push touching workflows failed: 403`** | Missing `Workflows` permission when editing `.github/workflows/*`. | Add **Workflows: Read and write** to Repository Permissions in GitHub App settings. |
| **`git_push` returns `FORBIDDEN` "rejected by the remote's branch protection"** | The push reached GitHub and a branch protection rule, ruleset, or hook refused it (required checks not passing on the commit, or a rule requiring pull requests). Retrying cannot help. | Let required checks pass first, add the App to the rule's bypass list, or merge through a pull request (`pr_merge`). |
| **`commit_status_create`, `check_runs_list`, or `workflow_*` returns `FORBIDDEN` with `permission_not_granted`** | The installation does not grant **Commit statuses**, **Checks**, or **Actions**. | Add the permission to the App, then approve the updated permissions on the installation. |
| **`Token minting: UNAVAILABLE`** | App ID or Private Key mismatch. | Verify `GITHUB_APP_ID` matches GitHub App ID, and that the `.pem` file corresponds to that exact App. |
| **Key rotation** | Need to rotate an existing key. | Generate a second key in GitHub first, update the `.pem` file on host, restart runner, then delete the old key in GitHub. |
| **Dashboard shows "No GitHub App installation is bound to this identity" after installing or saving on GitHub** | GitHub did not return to the dashboard: the App has no **Setup URL**, or **Redirect on update** is off for an App that was already installed. | Set the Setup URL and **Redirect on update** as in [Step 2](#step-2-register-the-github-app), then click **Connect GitHub App** again. For an already-installed App, save on **Configure** and click **Verify with GitHub** when the dashboard asks. |
| **"GitHub user authorization is unavailable"** | `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET_FILE` are missing, or the App's **Callback URL** is not this dashboard's `/dashboard/integrations/github` page. | Set both values for the runner and restart it, and register the Callback URL as in [Step 2](#step-2-register-the-github-app). |
| **"Your GitHub account cannot access installation …" or "Only the owner of the GitHub account …"** | You authorized as a different GitHub user than the one that owns the installation. | Switch GitHub accounts (or sign out of GitHub), then **Connect GitHub App** again. |
| **"GitHub did not confirm that you are an owner of the … organization"** | You are not an organization owner, or the App lacks **Members: Read-only**. | Ask an organization owner to connect it; add **Members: Read-only** to the App and approve it on the installation. |
| **"GitHub authorization was cancelled"** or **"… is invalid or expired"** | You declined on GitHub, took longer than 10 minutes, or reused an old link. | Click **Connect GitHub App** again. |
| **"GitHub user authorization is not configured"** or a disabled **Connect GitHub App** | The runner has no `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET`. | Set both and the App's Callback URL (`<origin>/dashboard/integrations/github`), then restart the runner. |
| **An installation is bound to the wrong identity, or you cannot reach it** | Releases before user verification let a setup link bind an installation without proving ownership. | Authorize as the account owner or an organization owner from the identity that should hold it; the binding moves and the audit log records `github.rebound`. The previous holder's audit shows `github.unbound`. |

## Where this page lives now

GitHub authorization lives on the **Integrations** page. The rail links to
[Integrations](/dashboard/integrations), which is also served at
`/dashboard/integrations/github`; `/dashboard/github` still works and redirects there, so
existing bookmarks and documentation links keep resolving. MCP server connections have
their own rail entry, [MCP Servers](/dashboard/mcp-servers).

## Callback in the new dashboard

Both dashboards handle GitHub's returns themselves. A setup return with `installation_id`
continues to GitHub's authorize page (automatically after a new installation, or through
**Verify with GitHub** for an existing one); the authorize return with `code` and `state`
connects the installation once. The page removes these values from the address after
handling them. A malformed value is ignored, a cancelled authorization says so, and a reused
or expired one is refused by the server.
