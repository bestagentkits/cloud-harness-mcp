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
| **Read issues and pull requests through `github_action`** | **Issues: Read-only** + **Pull requests: Read-only** + **Contents: Read-only** |
| **Create or update issues and pull requests through `github_action`** | **Issues: Read and write** + **Pull requests: Read and write** + **Contents: Read-only** |

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
   - **Callback URL:** Leave empty (unless using Access SSO OAuth redirect).
   - **Setup URL:** Leave empty.
4. **Webhook:**
   - Uncheck **Active** under the Webhook section (Cloud Harness does not require webhooks).
5. **Repository permissions:**
   - Set **Contents** to **Read and write** (or Read-only).
   - (Optional) Set **Workflows** to **Read and write** if your agents need to edit GitHub Actions.
6. **Where can this GitHub App be installed?:**
   - Select **Only on this account**.
7. Click **Create GitHub App**.

---

## Step 3: Download Private Key & Note IDs

After creating the App:

1. **App ID:** Copy the numeric **App ID** displayed at the top of the General settings page (e.g. `123456`).
2. **App Slug / Name:** Note the URL slug of your app (e.g. `cloud-harness-operator`).
3. **Generate Private Key:**
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

### 2. Update Environment Variables (`.env`)

In your server's `.env` or `/etc/cloud-harness-mcp/runtime.env`:

```dotenv
# Your numeric GitHub App ID
GITHUB_APP_ID=123456

# In owner-bearer mode: provide the numeric installation ID
GITHUB_APP_INSTALLATION_ID=78901234

# In cloudflare-access mode: provide the app slug for dashboard linking
GITHUB_APP_SLUG=cloud-harness-operator

# Container mount path to the private key (inside the runner)
GITHUB_APP_PRIVATE_KEY_FILE=/run/cloud-harness-secrets/github-app-private-key.pem
```

### 3. Restart the Runner

Restart containers so the runner picks up the new configuration:

```bash
docker compose down && docker compose up -d
```

---

## Step 6: Link in Operator Dashboard

1. Open the Operator Dashboard at `https://harness.zuey.me/dashboard`.
2. Navigate to **GitHub** in the left navigation rail.
3. If not already bound, click **Install / Link GitHub App**.
4. Authorize the application. The dashboard will display your active installation ID and bound repositories.

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
| **`Token minting: UNAVAILABLE`** | App ID or Private Key mismatch. | Verify `GITHUB_APP_ID` matches GitHub App ID, and that the `.pem` file corresponds to that exact App. |
| **Key rotation** | Need to rotate an existing key. | Generate a second key in GitHub first, update the `.pem` file on host, restart runner, then delete the old key in GitHub. |

## Where this page lives now

GitHub authorization is one tab of the single **Integrations** page. The rail links to
[Integrations](/dashboard/integrations), and the GitHub tab is at
`/dashboard/integrations/github`; `/dashboard/github` still works and redirects there, so
existing bookmarks and documentation links keep resolving. MCP server connections are the
second tab of the same page.
