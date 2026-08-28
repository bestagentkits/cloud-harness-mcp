# VPS deployment

This route installs the private trusted-operator service behind an existing nginx
instance. Compose publishes a credential-free TCP ingress proxy only on
`127.0.0.1:3100`; the API and runner remain on private networks and nginx
remains the only public ingress. The bootstrap script installs an HTTP server block but
does not obtain a certificate. Certbot is a separate required step.

`owner-bearer` remains the default. The optional Cloudflare Access route adds
an authentication edge to this topology; it does not replace the private
API/runner boundary or grant Cloudflare any Docker authority.

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

For an existing TLS-enabled installation, the Access-mode release deploy runs
the dedicated application-route upgrade before its public canary. It can also be
run idempotently after deploying a release that contains it:

```bash
sudo /usr/local/sbin/cloud-harness-upgrade-nginx
```

This command reads the configured `API_PUBLIC_HOSTS` allowlist without sourcing
the runtime file, selects the unique matching TLS server block, and refuses
ambiguous or pre-existing nonstandard application routing. It backs up the live
site under `/etc/cloud-harness-mcp/nginx-backups/`, installs the two
`/dashboard` locations and the exact streaming `/mcp-api-key` location when
they are missing, validates with `nginx -t`, and reloads nginx. Existing routes
must match the managed blocks exactly after comments and blank lines are
removed; otherwise the command fails closed without changing the site. A
failed validation or reload restores the exact backup and attempts to reload
it. The operation is idempotent. Do not use bootstrap for this upgrade.

Review `/etc/cloud-harness-mcp/runtime.env` as root. Do not print or transfer
its tokens through logs or shell history. Configure the optional GitHub App
private-key file only if private clone is required; see
[GitHub App setup for private repositories](github-app-private-repositories.md)
and the [configuration rationale](configuration.md#optional-github-app-repository-access).
In Access mode, also install the runner-only secret keyring file and use a
durable host artifact root. The maintained config template and schema remain
the exact setting authorities.

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

## Cloudflare Access rollout

Access mode is an explicit operator rollout after the code is merged and the
origin is healthy. It requires a hostname in an owner-controlled
Cloudflare-managed zone and the matching Zero Trust organization; the current
`sslip.io` hostname may not satisfy that prerequisite.

Use a compatibility deployment before changing authentication configuration.
Deploy the release while the existing owner-bearer service is healthy, then
deploy that exact SHA once more without changing configuration. The second pass
uses the newly installed deployment tooling and records the last-known-good
configuration and runner-only key directory. Only then switch to Access mode
and deploy again. If the Access canary or readiness check fails, automatic
rollback restores that known-good configuration together with the database,
artifacts, commit, and images. Do not combine the first code deployment and the
authentication cutover.

In the Cloudflare dashboard, use **Zero Trust → Integrations → Identity
providers → Add new identity provider** to configure and test
[GitHub](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/)
and
[Google](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/).
Then use **Zero Trust → Access controls → Applications → Create new
application → Self-hosted and private**. Add the selected public hostname
without a path so the same application protects `/mcp` and `/dashboard`, add
the trusted-operator Allow policy, and select both IdPs under Authentication.
Edit the application, then enable **Advanced settings → Managed OAuth** as
described in Cloudflare's
[Managed OAuth guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

Under **Allowed redirect URIs**, configure the exact callback URLs required by target AI clients:

- **Claude Desktop (Web/Cloud Connector):**
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`
- **Codex App / Native Desktop Clients (Loopback OAuth):**
  - `http://127.0.0.1:3118/callback/*`
  - `http://127.0.0.1:3118/*`
  - `http://localhost:3118/callback/*`
  - `http://localhost:3118/*`
- **ChatGPT Web / Custom MCP Connectors:**
  - `https://chatgpt.com/connector/oauth/*`
  - `https://chatgpt.com/connector_platform_oauth_redirect`
  - `https://chatgpt.com/api/aip/p/oauth/callback`

#### Why Allowed redirect URIs and wildcards are required

1. **RFC 7591 Dynamic Client Registration (DCR):** When an AI client initiates an OAuth connection to `https://harness.zuey.me/mcp`, it automatically sends metadata (including `redirect_uris`, `grant_types`, and `client_name`) to the Cloudflare Access registration endpoint (`/cdn-cgi/access/oauth/registration`). If the requested callback URI is not allowlisted in the Cloudflare application settings, Cloudflare rejects the request with `HTTP 400 Bad Request: {"error":"invalid_client_metadata","error_description":"redirect_uri is not allowed by the account configuration"}`.
2. **Loopback Port Pinning & Dynamic Subpaths:** Native desktop clients (such as Codex App using the `rmcp` engine) generate an ephemeral unique transaction ID per login attempt (e.g. `http://127.0.0.1:3118/callback/<TX_ID>`). Pinning the callback port (`mcp_oauth_callback_port = 3118` in `~/.codex/config.toml`) and adding wildcard subpaths (`/*`) in the Zero Trust Allowed redirect URIs allows these dynamic transaction subpaths to match and succeed without compromising security.
3. **ChatGPT Connector Subpaths & Least-Privilege Scoping:** ChatGPT Web generates per-connector callback URLs under `https://chatgpt.com/connector/oauth/<CALLBACK_ID>`. Allowlisting `https://chatgpt.com/connector/oauth/*` covers all dynamic connector instances while avoiding overly broad wildcards (such as `https://chatgpt.com/*`) that could risk authorization code leakage on arbitrary parameter-reflecting endpoints.

#### Managed OAuth Grant Session Duration vs Access Session Duration

Cloudflare Access governs OAuth clients and browser dashboard sessions through separate settings:

1. **Managed OAuth Grant session duration (AI OAuth Clients):** Under **Advanced settings → Managed OAuth → Grant session duration**, configure the desired continuity interval (Cloudflare recommends 1–2 weeks for CLI/agent clients, or longer up to 1 month where supported by the tenant). This sets how long the client's refresh token remains valid before requiring interactive browser re-authentication. Keep the **Access token lifetime** short (5–15 minutes, default 15 minutes) so silent refresh and policy re-evaluation continue normally.
2. **Access Application & Policy session duration (Dashboard Browser):** In the application and policy settings, configure **Session Duration** (up to 1 month) to control application token lifetime and when Access re-evaluates access. If the global Access session remains valid, Cloudflare can issue a new application token without requiring another interactive IdP login; interactive re-authentication is governed by the remaining global/IdP session state.
3. **Static Client Zero-Reauth Alternative:** For IDE/CLI coding agents (Claude Code, Cursor, Codex, etc.) that support static headers, configure them against the API-key gateway (`https://api.harness.zuey.me/mcp`) using a dashboard-managed API key (valid for up to 3,650 days, approximately 10 years) to avoid OAuth grant expirations entirely.

Configure the origin from that same application's issuer, audience, and JWKS
material, remove the owner bearer, and pin any legacy owner mapping to the
exact observed issuer and subject. Never infer a mapping from email. The mode
constraints and operator baseline are owned by
[configuration](configuration.md#authentication-and-request-policy).

Provisioning Cloudflare, DNS, IdPs, Access policy, and credentials is a live
owner operation and is not performed by this repository. Before promotion,
collect sanitized evidence for:

- protected-resource and authorization-server discovery from each release-
  gating client;
- GitHub and Google login producing the intended Access-normalized subject;
- refresh plus logout/revocation, followed by rejection at the origin;
- unknown and cross-principal resource denial;
- dashboard CSRF rejection and browser response/storage secret absence;
- per-principal GitHub App installation/repository reconciliation; and
- Access-mode deployment canary and rollback from the public HTTPS edge.

If a target client cannot complete Managed OAuth, stop and make the separate
Managed OAuth versus Workers OAuth Provider decision. Do not add a second
issuer, hidden bearer path, or unprotected hostname as a compatibility fix.

### API-key gateway rollout

Add the static-client lane only after the existing OAuth and dashboard lane is
healthy. Create a second Self-hosted Access application scoped exactly to
`harness.zuey.me/mcp-api-key`, with an audience distinct from the hostname-wide
application. Its only Allow policy is **Service Auth** for one dedicated Worker
service token. Do not add users, groups, bypass rules, or that service token to
the main `/mcp` and `/dashboard` application.

Store the token as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` Worker
secrets. Deploy the Worker manifest at
[`apps/api-key-gateway/wrangler.jsonc`](../apps/api-key-gateway/wrangler.jsonc),
which binds the custom hostname `api.harness.zuey.me`; do not enable a
`workers.dev` or preview URL. The same manifest provisions
`API_KEY_RATE_LIMITER`, an aggregate 600-request/60-second cap per Cloudflare
location. Confirm the deployed Worker version lists that binding and, in a
controlled preproduction route, prove exhaustion returns bounded JSON `429`
with `Retry-After: 60` while a failed/missing binding returns JSON `503` and
does not reach the origin. Do not weaken the origin's authoritative
per-credential limiter. Observe the verified service principal at the
origin, normalize and pin that exact value in
`API_KEY_GATEWAY_SERVICE_SUBJECT`, and set the separate application audience
and public URL in `API_KEY_GATEWAY_ACCESS_AUDIENCE` and
`API_KEY_GATEWAY_PUBLIC_URL`. Enable `API_KEY_AUTH_ENABLED` only after those
values are complete.

Roll out the schema-capable runner and API with the feature disabled first.
After the quiesced state backup and v2 migration, prove OAuth, GitHub/Google
dashboard login, and CSRF behavior before enabling the hidden route and Worker.
Then create a disposable short-lived key in the dashboard and canary:

1. initialize, list tools, and make one bounded call through
   `https://api.harness.zuey.me/mcp`;
2. reject the same key on `https://harness.zuey.me/mcp` and reject direct calls
   to `/mcp-api-key` without the exact Worker assertion;
3. revoke the key and prove the next gateway request returns JSON `401`; and
4. confirm the production Worker version contains the expected rate-limit
   binding and the sanitized preproduction `429`/fail-closed receipt; and
5. re-run Managed OAuth discovery/initialize and both IdP dashboard logins.

Record the exact release SHA, Access application identifiers/audiences, Worker
deployment, hostnames, and sanitized results separately. Never record either
the key or service-token values. The Worker route can be removed independently;
the OAuth/dashboard lane remains available.

## Deploy a release

The deploy command accepts only an exact 40-character commit that is an
ancestor of `origin/main`:

```bash
release_sha="$(git rev-parse HEAD)"
sudo /usr/local/sbin/cloud-harness-deploy "$release_sha"
```

[`deploy/scripts/deploy-release.sh`](../deploy/scripts/deploy-release.sh)
checks the hardcoded public origin, stops writes, snapshots the state database,
artifact store, and root-owned configuration/key files as one recovery set,
checks out the exact commit, builds fixed local images, starts systemd, waits
for readiness, and performs an auth-mode-aware canary. On error it restores the
prior recorded release plus the database and artifacts when available, reusing
the unchanged live configuration; the config/key copy is retained for coherent
manual recovery. A failed first install is disabled. Active job checkouts are
not part of the snapshot.

The deploy command takes a nonblocking host lock before reading or mutating the
shared checkout, service, snapshots, or release metadata. A concurrent manual
or automated invocation exits with status 75 and performs no rollback; rerun it
only after the active deployment finishes. This prevents one release from
rolling back another release's in-progress state.

Release deployment installs the fixed `cloud-harness-upgrade-nginx` command.
In Access mode it invokes the same fail-closed operation before the public
canary; owner-bearer deployments do not change nginx. If a later manual
rollback must remove those routes, restore the printed backup path to
`/etc/nginx/sites-available/cloud-harness-mcp.conf`, run `nginx -t`, and reload
nginx; normal application rollback can leave the backward-compatible routes in
place.

Owner-bearer canary uses the private bearer path. Access canary requires an
owner-provisioned Access service-token client ID/secret and the public HTTPS
endpoint, so the request traverses the Access edge; there is no local bearer
bypass. This proves the public deployment path, not a GitHub/Google Managed
OAuth user flow or release-gating client compatibility. Rotate or revoke the
canary credential separately. Store these three canary-only settings in the
root-owned `/etc/cloud-harness-mcp/canary-credentials` file, not the shared
runtime configuration; the deploy script exports them only to the transient
canary container. The exact environment names and invocation are owned by the deploy script and
[`scripts/deploy-canary.mjs`](../scripts/deploy-canary.mjs).

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

For an owner-bearer deployment, run the authenticated production workflow from
a trusted operator checkout with the bearer supplied only through the
environment:

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

This script is not Access/IdP verification; use the Access rollout checklist
above for that distinct live claim.

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

This leaves the project configuration, state, artifact store, backups, and any dedicated
certificate available for investigation. Remove them only after resolving
their exact ownership and retention requirements. See
[operations](operations.md) for backup and cleanup.

For an API-key-gateway rollback, disable the Worker custom route first, set
`API_KEY_AUTH_ENABLED=false`, confirm the hidden origin route returns 404, and
revoke the Worker service token. A prior binary that understands only metadata
schema v1 also requires the quiesced v2→v1 procedure in
[operations](operations.md#api-key-schema-rollback); that downgrade invalidates
all managed API keys while preserving unrelated metadata.
