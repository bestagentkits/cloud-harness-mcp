# GitHub App setup for private repositories

Cloud Harness uses a GitHub App only inside the trusted runner to clone, fetch,
pull, and optionally push private GitHub repositories. The runner exchanges the
App credentials for a short-lived installation token scoped to the repository
being operated on. The credential is not placed in the checkout, Git remote,
executor environment, or MCP result.

This guide covers GitHub.com. It assumes the private, single-owner deployment
described by the [security model](security-model.md).

## Decide the required access

Before creating the App, list the repositories Cloud Harness must access and
choose the narrowest permission level:

| Intended operation | Repository permission |
|---|---|
| Clone, fetch, and pull | **Contents: Read-only** |
| Push ordinary repository changes | **Contents: Read and write** |
| Push changes under `.github/workflows/` | **Contents: Read and write** and **Workflows: Read and write** |

Leave every other repository, organization, and account permission at **No
access**. GitHub recommends minimum permissions and documents `Contents` as the
permission for HTTP Git access. `Workflows` is needed only when the App must
access or edit GitHub Actions workflow files. See GitHub's
[permission guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## 1. Register the GitHub App

Create the App under the account that owns the target repositories, or under
their organization:

1. Open the personal or organization **Settings** page.
2. Select **Developer settings** → **GitHub Apps** → **New GitHub App**.
3. Enter a unique name and a homepage URL. The Cloud Harness repository URL is
   sufficient when the App has no separate website.
4. Leave callback and setup URLs empty. Cloud Harness does not use GitHub user
   authorization.
5. Clear **Active** under **Webhook**. This integration does not consume
   webhooks.
6. Under **Repository permissions**, grant the level selected above and leave
   all unrelated permissions at **No access**.
7. Under **Where can this GitHub App be installed?**, select **Only on this
   account** for an owner-operated private App.
8. Select **Create GitHub App**.

GitHub's current UI and field descriptions are documented in
[Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

## 2. Install it on selected repositories

From the new App's settings page:

1. Select **Install App** in the sidebar.
2. Select **Install** next to the user or organization that owns the target
   repositories.
3. Choose **Only select repositories**.
4. Select only the private repositories Cloud Harness needs, then finish the
   installation.

To operate across multiple accounts or organizations (e.g. a personal account
and several organization workspaces), install the same GitHub App on each
target account or organization. A single principal can bind multiple concurrent
installations in the operator dashboard; the runner automatically selects the
correct installation matching the repository owner (`owner/repo`) when minting
tokens.

Use **All repositories** only when that broader and future access is an
explicit owner decision. GitHub documents this flow in
[Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).
## 3. Collect the App ID, installation ID, and private key

Cloud Harness requires three values together:

- **App ID**: copy the numeric **App ID** from the App settings page. Do not use
  the Client ID.
- **Installation ID**: from **Install App**, open **Configure** for the installed
  account. The numeric final segment of the installation settings URL is the
  installation ID. GitHub also exposes it as `id` from authenticated App
  endpoints such as `GET /repos/{owner}/{repo}/installation`; see the
  [GitHub Apps REST reference](https://docs.github.com/en/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app).
- **Private key**: under **Private keys**, select **Generate a private key** and
  save the downloaded PEM file securely. GitHub retains only the public half,
  so the downloaded file cannot be recovered later.

Private keys do not expire automatically. Protect, rotate, and revoke them as
long-lived secrets. GitHub's [private-key guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
recommends a key vault or protected file instead of hardcoding the key.

## 4. Configure a production deployment

Production Compose mounts `/etc/cloud-harness-mcp` read-only into the runner at
`/run/cloud-harness-secrets`. Install the PEM on the host without printing it:

```bash
sudo install -d -m 700 -o root -g root /etc/cloud-harness-mcp
sudo test ! -e /etc/cloud-harness-mcp/github-app-private-key.pem && \
sudo install -m 600 -o root -g root \
  /absolute/path/to/downloaded-github-app-key.pem \
  /etc/cloud-harness-mcp/github-app-private-key.pem
```

The `test` command intentionally stops a first-install procedure rather than
overwriting an existing active key. If the destination already exists, follow
[Rotate or revoke a key](#rotate-or-revoke-a-key) and install the replacement
under a new filename. Then edit the root-owned runtime file with
`sudoedit /etc/cloud-harness-mcp/runtime.env` and add:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=78901234
GITHUB_APP_PRIVATE_KEY_FILE=/run/cloud-harness-secrets/github-app-private-key.pem
```

Replace both example IDs. The private-key path is the **runner container path**,
not the host path. Do not paste the PEM contents into the runtime file. The
supported `GITHUB_APP_PRIVATE_KEY` fallback is less safe and should be used only
when a file mount is unavailable. When both forms are present, the `_FILE`
value wins.

All three values must resolve successfully. If an ID or both key forms are
absent, the runner treats GitHub App access as disabled. If `_FILE` is set but
the target cannot be read, the runner fails during startup instead. Restart
through the maintained [deployment workflow](deployment.md#deploy-a-release)
so the runner reloads the configuration. Validate Compose without rendering
secrets to the terminal:

```bash
sudo docker compose \
  -f compose.yaml \
  -f compose.production.yaml \
  config --quiet
```

Do not paste `docker compose config` output into logs or support requests; it
may contain resolved environment values.

## Local Compose testing

For a local test, keep the PEM outside the repository and mount it only into
the runner. Create a private Compose override outside the checkout, for
example `/absolute/private/path/compose.github-app.yaml`:

```yaml
services:
  runner:
    volumes:
      - /absolute/private/path/github-app-private-key.pem:/run/cloud-harness-secrets/github-app-private-key.pem:ro
```

Protect the host file with `chmod 600`, set the same three environment values
in the ignored local runtime file, then include the override in Compose calls:

```bash
docker compose \
  -f compose.yaml \
  -f /absolute/private/path/compose.github-app.yaml \
  up -d runner api ingress
```

Use the same `-f` arguments when stopping this local stack. Never add the PEM,
override, or runtime environment file to Git.

## 5. Verify private repository access

Verification is a live GitHub operation. Use a disposable repository or branch
and a credential-free URL such as `https://github.com/OWNER/REPOSITORY.git`:

1. Call `workspace_open` through an authenticated MCP client.
2. Confirm `workspace_status`, `files_list`, and `git_fetch` work without a
   credential appearing in the remote URL, logs, or tool results.
3. If write access is intended, create a disposable branch and push a harmless
   commit. Do not test against a protected default branch.
4. Close the workspace with `workspace_close`.

A successful public-repository test does not prove the App is configured. A
successful private clone proves read access only; it does not prove push access.

## Troubleshooting

| Symptom | Check |
|---|---|
| GitHub App access appears disabled | Confirm both IDs and one key form are present in the runner's runtime environment, then restart the runner. |
| Runner fails while reading the key | Confirm the environment uses the container path, the production mount exists, and the host PEM is root-owned with mode `600`. |
| Repository not found or clone returns `404` | Confirm the App is installed on the repository's owning account and that the repository is included in **Only select repositories**. |
| Token minting returns `UNAVAILABLE` | Recheck App ID versus Client ID, installation ID, PEM/App pairing, key revocation, and runner DNS/egress to `api.github.com`; Git transport also needs `github.com`. |
| Clone works but push returns `403` | Change `Contents` to **Read and write**, approve the changed installation permission, and check branch/ruleset restrictions. |
| A push touching `.github/workflows/` fails | Add **Workflows: Read and write** only if modifying workflow files is intended, then approve the updated installation permission. |

The broker deliberately returns a sanitized error instead of GitHub's raw
credential-bearing response. Use GitHub's installation settings and runner
health logs for diagnosis; never enable logging that prints tokens or PEM data.

## Rotate or revoke a key

1. Generate a second private key in the GitHub App settings. GitHub does not
   allow deletion of an App's only private key, so create the replacement
   before revoking the old key.
2. Choose a new unique filename and confirm it does not already exist. For
   example:

   ```bash
   sudo test ! -e /etc/cloud-harness-mcp/github-app-private-key-20260817T081500Z.pem && \
   sudo install -m 600 -o root -g root \
     /absolute/path/to/replacement-github-app-key.pem \
     /etc/cloud-harness-mcp/github-app-private-key-20260817T081500Z.pem
   ```

3. Update `GITHUB_APP_PRIVATE_KEY_FILE` to the corresponding runner path,
   restart the runner, and repeat the private clone and leak check.
4. Revoke the old key in GitHub only after the replacement succeeds, then
   remove the exact superseded host file.

For a suspected compromise, generate and activate a replacement immediately.
If that cannot be done safely, uninstall the App from the affected account to
contain access before rebuilding the integration. Review the installation's
repository selection and permissions as part of the incident response.

## Configuration authority

The maintained environment names and production mount are owned by the
environment template, [`apps/runner/src/config.ts`](../apps/runner/src/config.ts),
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts), and
[`compose.production.yaml`](../compose.production.yaml). Repository token
scoping is implemented by
[`apps/runner/src/github-app-broker.ts`](../apps/runner/src/github-app-broker.ts).
