# VPS deployment

This route installs the private single-owner service behind an existing nginx
instance. Compose publishes a credential-free TCP ingress proxy only on
`127.0.0.1:3100`; the API and runner remain on private networks and nginx
remains the only public ingress. The bootstrap script installs an HTTP server block but
does not obtain a certificate. Certbot is a separate required step.

## Prerequisites and safe preflight

The host needs Docker Engine/Compose, nginx, Certbot with the nginx plugin,
Git, curl, OpenSSL, systemd, and an owner-controlled checkout of this public
repository. The hostname must resolve to the VPS and ports 80/443 must reach
nginx.

Inspect before changing an existing nginx host:

```bash
sudo nginx -t
sudo nginx -T > /tmp/nginx-before-cloud-harness.txt
sudo certbot certificates
sudo ss -ltnp
sudo test ! -e /etc/nginx/sites-available/cloud-harness-mcp.conf
sudo test ! -e /etc/nginx/sites-enabled/cloud-harness-mcp.conf
```

Also search `nginx -T` output for another
`server_name cloud-harness-mcp.46-250-239-227.sslip.io`. Stop if the hostname
or target filenames already belong to another service. If this project was
previously installed, back up those two exact files/symlinks before continuing
instead of treating failed `test` commands as permission to overwrite them.

## First install

From a reviewed checkout:

```bash
sudo ./deploy/scripts/bootstrap-vps.sh
```

The executable script is
[`deploy/scripts/bootstrap-vps.sh`](../deploy/scripts/bootstrap-vps.sh). It
creates root-owned runtime/state directories, generates independent bearer
tokens only when the runtime file does not already exist, installs fixed deploy
and rollback commands, installs the systemd unit and this project's dedicated
nginx file, validates nginx, and reloads it.

Treat bootstrap as a first-install operation. Running it again overwrites this
project's dedicated nginx target with the repository's HTTP template, including
Certbot edits in that file. Back up and deliberately reapply TLS configuration
before any rerun.

Review `/etc/cloud-harness-mcp/runtime.env` as root. Do not print or transfer
its tokens through logs or shell history. Configure the optional GitHub App
private-key file only if private clone is required; see
[configuration](configuration.md#optional-private-github-clone).

The current bootstrap sudoers rule grants the fixed deploy commands to the
`dev` account. Verify that this is the intended `VPS_USER`; if not, change the
root-owned rule deliberately and validate it with `visudo -cf` before adding
the GitHub environment secret. Install the dedicated Actions public key in
`~dev/.ssh/authorized_keys` with both `restrict` and the root-owned forced
command; do not install it as an unrestricted login key:

```text
restrict,command="/usr/local/sbin/cloud-harness-deploy-ssh" ssh-ed25519 PUBLIC_KEY_MATERIAL cloud-harness-github-actions
```

[`deploy/scripts/deploy-ssh-wrapper.sh`](../deploy/scripts/deploy-ssh-wrapper.sh)
rejects an interactive shell, forwarding, and every command except the exact
quoted deploy command with one 40-character lowercase commit SHA. This remains
required even when the host's operator account has broader interactive sudo.

## Obtain HTTPS with the existing nginx

After the HTTP server block is enabled and the hostname resolves correctly:

```bash
sudo nginx -t
sudo certbot --nginx \
  -d cloud-harness-mcp.46-250-239-227.sslip.io \
  --redirect
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Certbot should modify only the dedicated server block after nginx has
unambiguously matched its `server_name`. Re-run `nginx -T` and compare against
the preflight capture. Do not delete or replace certificates used by other
sites.

## Deploy a release

The deploy command accepts only an exact 40-character commit that is an
ancestor of `origin/main`:

```bash
release_sha="$(git rev-parse HEAD)"
sudo /usr/local/sbin/cloud-harness-deploy "$release_sha"
```

[`deploy/scripts/deploy-release.sh`](../deploy/scripts/deploy-release.sh)
checks the hardcoded public origin, quiesces and backs up SQLite, checks out the
exact commit, builds fixed local images, starts systemd, waits for readiness,
and performs an authenticated MCP initialization smoke check. On error it
restores the prior recorded release when available or disables the first
install.

Verify locally and externally:

```bash
curl --fail http://127.0.0.1:3100/readyz
curl --fail https://cloud-harness-mcp.46-250-239-227.sslip.io/readyz
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://cloud-harness-mcp.46-250-239-227.sslip.io/mcp
sudo ss -ltnp
```

The unauthenticated MCP request should be rejected; readiness should succeed.
Confirm `3100` is loopback-only, the ingress container has no runtime secrets,
and no API, runner, or executor port is public.

From a trusted operator checkout, run the authenticated production workflow
with the bearer supplied only through the environment:

```bash
MCP_URL="https://cloud-harness-mcp.46-250-239-227.sslip.io/mcp" \
MCP_BEARER_TOKEN="<owner-provided-token>" \
npm run verify:production
```

[`scripts/verify-production.mjs`](../scripts/verify-production.mjs) owns that
workflow. It opens a disposable public workspace, writes and executes inside
it, exercises modern and legacy MCP negotiation, tests cancellation, closes
the workspace, and emits sanitized JSON. It intentionally records the optional
private GitHub App clone as not run; repeat a separate leak check only when the
owner supplies valid App credentials.

## GitHub Actions deployment

The production environment used by
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) requires:

- `DEPLOY_SSH_KEY`
- `VPS_HOST_KEY`
- `VPS_HOST`
- `VPS_USER`

The workflow deploys only after successful CI on `main` (or a manual dispatch),
pins the SSH host key, passes an exact commit SHA to the fixed sudo command,
uses a forced-command deployment key, and removes ephemeral SSH files. Protect the `production` environment and
restrict who may approve or modify these secrets.

GitHub release automation is separate from deployment. After successful CI,
`dev` produces beta releases and `main` produces stable releases from
Conventional Commit history; it requires `contents: write` for the workflow
token and branch protection that permits its generated version/changelog
commit. Production deployment remains tied to successful `main` CI, so a
release tag is not itself production-deployment evidence.

## Rollback or disable the route

For a compatible previous commit:

```bash
sudo /usr/local/sbin/cloud-harness-rollback
```

For a first-install rollback or urgent route disable:

```bash
sudo systemctl disable --now cloud-harness-mcp.service
sudo unlink /etc/nginx/sites-enabled/cloud-harness-mcp.conf
sudo nginx -t
sudo systemctl reload nginx
```

This leaves the project configuration, state, backups, and any dedicated
certificate available for investigation. Remove them only after resolving
their exact ownership and retention requirements. See
[operations](operations.md) for backup and cleanup.
