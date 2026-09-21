---
title: Troubleshooting & Diagnostics
description: Resolution playbooks for common errors, clone issues, and runtime states.
---

# Troubleshooting & Diagnostics

## Common Issues & Fixes

### 1. `docker: No such image: cloud-harness-executor:local`
**Cause:** Local executor image was pruned by a host Docker cleanup or never built.
**Fix:** Rebuild the image from the project root:
```bash
docker compose --profile images build executor-image
```

---

### 2. `repository clone failed: unauthorized`
**Cause:** Attempting to clone a private repository without a valid GitHub App installation.
**Fix:**
1. Open the Operator Dashboard → **GitHub**.
2. Click **Install GitHub App** and authorize the target repository.
3. Ensure the repository URL matches the format `https://github.com/owner/repo.git`.

---

### 3. `workspace expired: TTL exceeded`
**Cause:** The workspace reached its 15-minute wall-clock limit or 5-minute idle limit.
**Fix:** Workspaces are ephemeral by design. Re-open a workspace using `workspace_open` with a fresh idempotency key.

---

### 4. API Key Denied (`401 Unauthorized`)
**Cause:** Expired key, revoked key, or key used against the Managed OAuth URL instead of the gateway.
**Fix:**
- Ensure the client URL is `https://api.harness.zuey.me/mcp` (NOT `https://harness.zuey.me/mcp`).
- Verify key validity in the Dashboard under **API Keys**.

---

### 5. OAuth DCR Error (`redirect_uri is not allowed by the account configuration`)
**Cause:** Cloudflare Access Managed OAuth rejected Dynamic Client Registration because the client's callback URL was not allowlisted.
**Fix:**
1. Log into [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications**.
2. Edit the application for your MCP hostname → **Advanced settings** → **Managed OAuth**.
3. Add the required callback URLs to **Allowed redirect URIs**:
   - **Claude Desktop:** `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`
   - **Codex App / Native Clients:** Pin `mcp_oauth_callback_port = 3118` in `~/.codex/config.toml` and add `http://127.0.0.1:3118/callback/*`, `http://127.0.0.1:3118/*`, `http://localhost:3118/callback/*`, and `http://localhost:3118/*`.
   - **ChatGPT Web:** `https://chatgpt.com/connector/oauth/*`, `https://chatgpt.com/connector_platform_oauth_redirect`, and `https://chatgpt.com/api/aip/p/oauth/callback`.

---

### 6. Frequent MCP Sign-out or Re-authentication Prompts in AI Tools
**Cause:** When connecting via Managed OAuth (`https://harness.zuey.me/mcp`), client continuity depends on Cloudflare Access's **Grant session duration** (refresh token lifetime). When the grant expires, the client prompts for interactive browser re-authentication.

**Fix:**
1. **Adjust Managed OAuth Grant Session Duration (OAuth Clients):**
   - Log into [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications**.
   - Edit the MCP application → **Advanced settings** → **Managed OAuth**.
   - Set **Grant session duration** to your preferred continuity interval (Cloudflare recommends 1–2 weeks for CLI/agent clients, or longer up to 1 month where supported by the tenant).
   - Keep the **Access token lifetime** short (5–15 minutes, default 15 minutes) so silent refresh and policy re-evaluation continue normally.
2. **Switch to Static API Key Gateway (Zero-Reauth for Coding Tools):**
   - For IDE/CLI coding agents (Claude Code, Cursor, Codex, etc.) that support static headers, generate an API key from the Dashboard at `https://harness.zuey.me/dashboard/api-keys` (configurable for 1 to 3,650 days, approximately 10 years).
   - Configure the tool to connect directly to `https://api.harness.zuey.me/mcp` with `Authorization: Bearer <api-key>` to eliminate interactive OAuth prompts entirely.

---

### 7. Local Stdio: `--workspace path must be absolute` or Directory Error
**Cause:** The `--workspace` argument provided to `cloud-harness-mcp --transport stdio` is relative, does not exist, or points to a regular file instead of a directory.
**Fix:** Provide a valid, existing absolute directory path (e.g. `/home/user/project` or `/mnt/c/Users/user/project` in WSL). Native Windows path formats (like `C:\...`) are unsupported in v1 local stdio mode; run the process inside WSL instead.

---

### 8. ChatGPT: `FORBIDDEN: This conversation does not support developer MCPs`
**Cause:** ChatGPT allows tool discovery, but blocks invocation because the active conversation surface (e.g. Custom GPT, Project chat, Canvas, Mobile app, or temporary chat) or user account restricts draft developer MCPs, or the connector is in draft state without workspace publishing.
**Fix:**
1. **Open Standard 1-on-1 Web Chat:** Use ChatGPT Web in a standard chat thread and select or `@mention` CloudHarness.
2. **Enable Developer Mode:** Verify that **Settings → Apps → Advanced Settings → Developer mode** is enabled for your account.
3. **Publish Connector (Workspace Admins):** In **Workspace Settings → Apps → Drafts**, select CloudHarness and click **Publish** to promote it from a draft Developer MCP to an approved workspace **Custom Connector**.
4. **Verify Plan Support:** Full MCP write actions (such as `workspace_open`) are in beta for ChatGPT Business, Enterprise, and Edu plans.
5. **Start Fresh Thread:** If the connector was recently created or authorized, open a new chat session to clear stale conversation state.
6. See [ChatGPT Configuration Guide](/ai-tools/chatgpt) for complete setup steps.

---

### 9. Dashboard Shows a Diagnostic Page or JSON `authentication_failed`
**Cause:** The request reached the Cloud Harness origin without a valid Cloudflare Access assertion, so the API could not identify the caller. Typical causes: the Access application does not cover the dashboard hostname and path, a bypass or service-auth policy matched the request, the browser resolved the origin address instead of the Cloudflare-proxied hostname, or the origin no longer agrees with the live Access application (for example after the application was recreated, or after the team's signing keys rotated).

**Fix:**
1. Read the reason code shown on the page, or the `access assertion rejected` line in the API log. It names the failing check — `missing_assertion`, `wrong_audience`, and `jwks_unavailable` cover most incidents, and the diagnostic module owns the full set.
2. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications**, confirm the application covers the dashboard hostname and path, and compare its **Application Audience (AUD) tag** with the origin's `CLOUDFLARE_ACCESS_AUDIENCE`.
3. Open the dashboard on the Cloudflare-proxied public hostname (`https://harness.zuey.me/dashboard`). A hosts-file or router override that resolves it to the origin address bypasses Access and produces this page.
4. For `jwks_unavailable` or `unknown_key`, check that the API container can reach the team's `/cdn-cgi/access/certs` endpoint and that the host clock is correct.

Non-browser clients keep receiving the compact `{"error":"authentication_failed"}` JSON body; only browser navigations render the diagnostic page, and no token, assertion, or identity claim is ever shown.

---

### 10. `DEPENDENCY_EGRESS_UNAVAILABLE` on `workspace_open` (HTTP 503)
**Cause:** The effective network profile is `dependency-access` — the shipped default — but the Linux host firewall is not provisioned, or its rules have drifted, so the runner fails the open closed instead of silently downgrading to `network-none`.
**Fix:**
1. Provision the host firewall on the Docker host:
```bash
bash deploy/scripts/setup-dependency-firewall.sh
```
2. Confirm **Egress readiness** reports `Ready` on the dashboard [Settings](/dashboard/settings) page.
3. Open the workspace again with a fresh idempotency key. The failed attempt kept its key with a `FAILED` status, and replaying that key returns the failed record without retrying the attestation.
To work without egress meanwhile, reset the default to `network-none` on the Settings page or open the workspace with `networkProfile: "network-none"`.

---

### 11. `GITHUB_PERMISSION_MISSING` / `403 Resource not accessible by integration`
**Cause:** No configured credential can perform the requested `github_action`. The GitHub App installation did not grant the scope the action needs, and no fallback credential is available for the requesting principal.
**Fix:**
1. The error names the missing scope. Add that permission to the GitHub App and approve the pending installation change on GitHub, then retry. The [GitHub App setup](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/docs/github-app-private-repositories.md) guide lists which operations need which permission. An action-scoped token also carries **Contents: Read-only** so that `gh` can resolve repository metadata, so that permission is required for `github_action` even when the named action scope is already granted.
2. Alternatively, configure the fallback credential for that principal: the runner-environment `GH_TOKEN`/`GITHUB_TOKEN` in `owner-bearer` mode, or that principal's global runtime secret in Access mode. The runner-environment credential is harness-side only and never enters an executor; a principal's global runtime secret is injected into that principal's workspaces, so it also authenticates the workspace `gh` CLI.
A `403` from the helper is never retried, because the operation may already have had side effects; inspect the issue or pull request before retrying.

### 12. `LIMIT_EXCEEDED: active workspace limit reached` on `workspace_open`
**Cause:** The principal already holds `MAX_ACTIVE_WORKSPACES_PER_OWNER` counted workspaces (`CREATING`, `ACTIVE`, `NETWORK_QUARANTINED`). A record in `REAPING` is in flight to teardown and holds no slot. Multiple concurrent workspaces are supported by design, so this is a quota rather than a harness limitation.
**Fix:**
1. Call `workspace_list` to see the counted workspaces, then `workspace_close` one you no longer need. Closing removes that workspace's files, so finalize or push unpushed work first.
2. An `ACTIVE` workspace also frees its slot when its idle or wall TTL expires. A `NETWORK_QUARANTINED` record does not expire, so close it explicitly.
3. Raise `MAX_ACTIVE_WORKSPACES_PER_OWNER` on the runner (default `3`, maximum `64`) after sizing host memory for the new limit, because each counted workspace may use up to 1 GiB of container memory, one CPU, and 256 pids.
Lowering the limit never reaps an existing workspace; it only blocks new admission and recovery until the counted total drops.

### 13. A workspace is stuck in `REAPING`
**Cause:** A teardown that failed before its final `CLOSED` write leaves the record in `REAPING`. A `REAPING` record holds no capacity slot, so it never blocks `workspace_open`; the visible symptom is a workspace that will not disappear from the dashboard.
**Fix:** Call `workspace_close` again on that workspace. The close path skips the claim for a record already in `REAPING` and retries container and path removal, so a repeat close is the supported remedy. Only the fenced dashboard close refuses a `REAPING` record with `409 CONFLICT`. If removal keeps failing, fix the underlying Docker or filesystem fault rather than running broad Docker or database cleanup.

### 14. `agentkit` toolkit fails during `workspace_open`
**Cause:** The licensed AgentKit kit kind fails closed by design, and each message names the missing prerequisite.
**Fix:**
1. `AgentKit kits are not configured on this instance` — the operator must set both `AGENTKIT_REGISTRY_KEY_ID` and `AGENTKIT_REGISTRY_PUBLIC_KEY` (the pinned Ed25519 registry signing key) and restart the runner.
2. `needs the <name> secret stored for this principal` — store the AgentKit licence token (an `ak_dev_`/`ak_cli_` credential) as a global secret with that name (`AGENTKIT_REGISTRY_TOKEN` unless `AGENTKIT_REGISTRY_CREDENTIAL_SECRET` changes it). The secret must be created with `purpose: provisioning`; the runner refuses a `runtime`-purpose token so it can never be injected into an executor. Credentials are never accepted as tool arguments.
3. `registry rejected the credential ... (not_licensed | not_authenticated | license_inactive)` — the token has no entitlement for that `kitId`, or is not a registry bearer. Re-issue it from the AgentKit account that owns the licence.
4. `manifest signature did not verify` / `signed by key ...; pinned key is ...` — the registry signing key rotated or the pinned key is stale. Update `AGENTKIT_REGISTRY_KEY_ID` and `AGENTKIT_REGISTRY_PUBLIC_KEY` together; do not disable verification.
5. `package digest did not match the signed manifest`, `must contain exactly one <kitId> root directory`, or `outside the <kitId> root` — the downloaded artifact is not the published package. Retry once; if it persists, treat it as an upstream publish problem instead of mounting the content.
6. `no published release for kit <kitId>` — that kit has no signed release on the requested channel yet. Try `channel: "beta"`, or pin a version that exists.

### 15. Uploaded operator skills do not appear in `skills_list`
**Cause:** The `built-in` tier is populated only when the runner is pointed at an operator-owned host directory, and only reads a strict layout.
**Fix:**
1. Set `BUILTIN_SKILLS_ROOT` to an absolute host directory in the runner environment (`/etc/cloud-harness-mcp/runtime.env` or `.env`) and restart the stack; with the variable unset the executor mounts nothing and the tier stays empty by design.
2. Upload skills as `<root>/<skill-name>/SKILL.md`; a directory without `SKILL.md` is ignored.
3. Confirm the host path is readable by the runner and that the directory exists (`deploy/scripts/bootstrap-vps.sh` creates `/var/lib/cloud-harness/skills` on first install).
4. Remember the tier outranks project skills: a same-named `.agents/skills` or `.cloud-harness/skills` entry appears under `shadowed`, not as the selected skill.
5. Only changes to already-open workspaces need a reopen; a new workspace sees an updated upload immediately.
6. `BUILTIN_SKILLS_ROOT` is reserved and is now the single name the worker reads. If the runner rejects a stored secret or environment record with that name (`INVALID_INPUT`), remove it with `secret_delete` (deletion of a reserved name stays allowed) and reopen. The removed `CH_BUILTIN_SKILLS_ROOT` override is no longer read: rename it to `BUILTIN_SKILLS_ROOT`. A container created before this change keeps its old environment until it is closed or rebuilt.
