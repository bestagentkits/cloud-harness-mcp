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
**Cause:** The workspace reached its wall-clock lifetime or idle timeout (15 and 5 minutes by default; the operator can change both in Dashboard → [Settings](/dashboard/settings#workspace-limits-lifecycle) for workspaces opened afterwards).
**Fix:** Workspaces are ephemeral by design. While the workspace is `EXPIRED_RECOVERABLE`, `workspace_recover` restores or exports its work. Otherwise re-open a workspace using `workspace_open` with a fresh idempotency key.

If the workspace `error` starts `executor reconciliation failed during startup:`, the workspace did not time out: its executor could not be restarted or rebuilt after a runner restart. Other workspaces are unaffected. During the recoverable grace its checkout is kept, so `workspace_recover` rebuilds the executor once the cause in the message is fixed; afterwards it is auto-closed like any expired workspace.

---

### 4. API Key Denied (`401 Unauthorized`)
**Cause:** Expired key, revoked key, or key used against the Managed OAuth URL instead of the gateway.
**Fix:**
- Ensure the client URL is `https://api.harness.zuey.me/mcp` or, for the MCP Gateway, `https://api.harness.zuey.me/mcp-gateway` (NOT `https://harness.zuey.me/mcp` or `https://harness.zuey.me/mcp-gateway`).
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
**Cause:** A client on the Managed OAuth lane (`https://harness.zuey.me/mcp`) must sign in again in the browser when its OAuth grant (refresh session) expires. The short access-token lifetime is not the cause: tokens refresh silently while the grant is valid.

**Fix:**
1. **Lengthen the grant:** open **Dashboard → [Settings](/dashboard/settings#mcp-oauth-sessions) → MCP OAuth sessions** and turn on **Stay signed in** (the provider maximum), or choose a longer duration. Keep the access-token lifetime short; a longer token does not reduce sign-ins.
   - If the panel is read-only because no provider integration is configured, set **Grant session duration** in [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications** → the MCP application → **Advanced settings** → **Managed OAuth** instead.
2. **Switch to the Static API Key Gateway (coding tools):**
   - For IDE/CLI coding agents (Claude Code, Cursor, Codex, etc.) that support static headers, generate an API key from the Dashboard at `https://harness.zuey.me/dashboard/api-keys` (configurable for 1 to 3,650 days, approximately 10 years).
   - Configure the tool to connect directly to `https://api.harness.zuey.me/mcp` with `Authorization: Bearer <api-key>` to avoid OAuth sign-in prompts entirely.

---

### 7. Local Stdio: `--workspace path must be absolute` or Directory Error
**Cause:** The `--workspace` argument provided to `cloud-harness-mcp --transport stdio` is relative, does not exist, or points to a regular file instead of a directory.
**Fix:** Provide a valid, existing absolute directory path (e.g. `/home/user/project` or `/mnt/c/Users/user/project` in WSL). Native Windows path formats (like `C:\...`) are unsupported in v1 local stdio mode; run the process inside WSL instead.

---

### 7a. Local `--workspace-config`: startup error, `CONFLICT`, or `UNAVAILABLE`
**Cause and fix:**
- **`failed to load --workspace-config`:** the file has an unknown field, duplicate key, YAML alias, invalid name, or wrong `version`, or a registered path is missing, not a directory, or nested inside another. Fix the named entry and restart.
- **`CONFLICT` asking you to pass `workspaceId`:** more than one folder is registered and the call named none. Call `workspace_list` and pass the `workspaceId` on every call (over stdio, `workspace_set_active` can set a default; the local HTTP endpoint rejects it).
- **Retryable `UNAVAILABLE` or `rootAvailable: false`:** the folder vanished or was replaced since startup, for example a dropped NFS mount. Restore the mount and retry.
- **`local HTTP mode requires MCP_BEARER_TOKEN`:** set a 32-512 character token in `MCP_BEARER_TOKEN` or `MCP_BEARER_TOKEN_FILE`.

See [Several local workspaces from one server](/connect#several-local-workspaces-from-one-server).

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
To work without egress meanwhile, reset the default to `network-none` on the Settings page or open the workspace with `networkProfile: "network-none"` under a new idempotency key. An omitted profile and an explicit `network-none` are different requests, so reusing the failed open's key with the explicit profile returns `CONFLICT`.

---

### 11. `GITHUB_PERMISSION_MISSING` / `403 Resource not accessible by integration`
**Cause:** No configured credential can perform the requested `github_action`. The GitHub App installation did not grant the scope the action needs, and no fallback credential is available for the requesting principal.
**Fix:**
1. The error names the missing scope. Add that permission to the GitHub App and approve the pending installation change on GitHub, then retry. The [GitHub App setup](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/docs/github-app-private-repositories.md) guide lists which operations need which permission. An action-scoped token also carries **Contents: Read-only** so that `gh` can resolve repository metadata, so that permission is required for `github_action` even when the named action scope is already granted.
2. Alternatively, configure the fallback credential for that principal: the runner-environment `GH_TOKEN`/`GITHUB_TOKEN` in `owner-bearer` mode, or that principal's global runtime secret in Access mode. The runner-environment credential is harness-side only and never enters an executor; a principal's global runtime secret is injected into that principal's workspaces, so it also authenticates the workspace `gh` CLI.
A `403` from the helper is never retried, because the operation may already have had side effects; inspect the issue or pull request before retrying.
3. Issue actions accept a pull request number, because on GitHub a pull request is also an issue: `issue_view` returns its issue view and `issue_comment` posts a conversation comment. Those calls also need **Pull requests** permission at the same level (Read-only for `issue_view`, Read and write for comments and labels). When the installation lacks it, the error says the number most likely names a pull request and names `pull_requests`; grant the permission, or use `pr_view` / `pr_comment`.
4. `pr_merge` and `pr_auto_merge_enable` need **Contents: Read and write** as well as **Pull requests: Read and write**; the error names both scopes. Review actions (`pr_review`, `pr_review_comment`, thread, reviewer, and draft/ready actions) need only **Pull requests: Read and write**.

### 11a. Review or merge errors (`GITHUB_REVIEW_NOT_ALLOWED`, `GITHUB_REVIEW_COMMENT_INVALID`, `GITHUB_REVIEWER_UNASSIGNABLE`, `GITHUB_MERGE_BLOCKED`, `GITHUB_MERGE_CONFLICT`, `GITHUB_AUTO_MERGE_UNAVAILABLE`)
**Cause:** GitHub accepted the credential but refused the pull request operation itself.
**Fix:**
- `GITHUB_REVIEW_NOT_ALLOWED`: the acting identity authored the PR; GitHub does not let it approve or request changes on its own PR. Use `pr_comment` or have another identity review.
- `GITHUB_REVIEW_COMMENT_INVALID`: the `path`/`line` is not in the PR diff, is outdated, or `commitId` is not part of the PR. Re-read `pr_view` (`headRefOid`) and the changed files, then retry on a line inside the diff.
- `GITHUB_REVIEWER_UNASSIGNABLE`: the user is not a collaborator, is the PR author, or the team slug is not in the repository's organization.
- `GITHUB_MERGE_BLOCKED`: required checks, required approvals, branch protection, or a moved head blocks the merge. Check `mergeStateStatus` and `reviewDecision` from `pr_view`; use `pr_auto_merge_enable` to merge once the requirements pass.
- `GITHUB_MERGE_CONFLICT`: update the PR branch and resolve the conflict, then retry.
- `GITHUB_AUTO_MERGE_UNAVAILABLE`: the repository does not allow auto-merge, or the PR is already mergeable (merge it directly).
- A successful `pr_merge` or `pr_auto_merge_enable` result that carries a `warning`: the request went through, but the harness could not fully read the pull request state afterwards. Do not retry it; read `pr_view` to get the merge commit or auto-merge state.

### 12. `LIMIT_EXCEEDED: active workspace limit reached` on `workspace_open`
**Cause:** The principal already holds `MAX_ACTIVE_WORKSPACES_PER_OWNER` counted workspaces (`CREATING`, `ACTIVE`, `NETWORK_QUARANTINED`). A record in `REAPING` is in flight to teardown and holds no slot. Multiple concurrent workspaces are supported by design, so this is a quota rather than a harness limitation.
**Fix:**
1. Call `workspace_list` to see the counted workspaces, then `workspace_close` one you no longer need. Closing removes that workspace's files, so finalize or push unpushed work first.
2. An `ACTIVE` workspace also frees its slot when its idle or wall TTL expires. A `NETWORK_QUARANTINED` record does not expire, so close it explicitly.
3. Raise the quota in Dashboard → [Settings](/dashboard/settings#workspace-limits-lifecycle) → **Workspace limits & lifecycle**, or `MAX_ACTIVE_WORKSPACES_PER_OWNER` on the runner when no Dashboard override is set (default `3`, maximum `64`), after sizing host memory for the new limit, because each counted workspace may use up to 1 GiB of container memory, one CPU, and 256 pids.
Lowering the limit never reaps an existing workspace; it only blocks new admission and recovery until the counted total drops.

### 13. A workspace is stuck in `REAPING`
**Cause:** A teardown that failed before its final `CLOSED` write leaves the record in `REAPING`. A `REAPING` record holds no capacity slot, so it never blocks `workspace_open`; the visible symptom is a workspace that will not disappear from the dashboard.
**Fix:** Call `workspace_close` again on that workspace. The close path skips the claim for a record already in `REAPING` and retries container and path removal, so a repeat close is the supported remedy. Only the fenced dashboard close refuses a `REAPING` record with `409 CONFLICT`. If removal keeps failing, fix the underlying Docker or filesystem fault rather than running broad Docker or database cleanup.

### 14. Dashboard skill ZIP upload returns `413` below 8 MiB
**Cause:** Older managed nginx dashboard routes inherit the server-level 1 MiB request cap even though Cloud Harness accepts skill archives up to 8 MiB.
**Fix:** Deploy the current release or run `deploy/scripts/upgrade-nginx-dashboard.sh` on the host. The managed `/dashboard/` route is upgraded to `client_max_body_size 8m`. Archives larger than 8 MiB are still rejected intentionally by the API and runner.

**Also rejected as `INVALID_INPUT`:** an archive with more than 200 `SKILL.md` documents, more than 20,000 files, contents that expand beyond 32 MiB, skills whose published files add up to more than 32 MiB (a file inside nested skills counts once for each skill that contains it), a `SKILL.md` longer than 64 Ki characters, a path that is both a file and a directory, or any symbolic link or special-file entry. Each skill's whole directory is imported; `__MACOSX/`, `.DS_Store`, and files outside skill directories are ignored. A single skill above 512 files, 16 MiB, or 32 nested directory levels is reported as `LIMIT_EXCEEDED` on its own row (the result's `message` names the limit) while the rest are imported. Split a larger library into several archives.

---

### 15. `agentkit` toolkit fails during `workspace_open`
**Cause:** The licensed AgentKit kit kind fails closed by design, and each message names the missing prerequisite.
**Fix:**
1. `AgentKit kits are not configured on this instance` — the operator must set both `AGENTKIT_REGISTRY_KEY_ID` and `AGENTKIT_REGISTRY_PUBLIC_KEY` (the pinned Ed25519 registry signing key) and restart the runner.
2. `needs the <name> secret stored for this principal` — store the AgentKit licence token (an `ak_dev_`/`ak_cli_` credential) as a global secret with that name (`AGENTKIT_REGISTRY_TOKEN` unless `AGENTKIT_REGISTRY_CREDENTIAL_SECRET` changes it). The secret must be created with `purpose: provisioning`; the runner refuses a `runtime`-purpose token so it can never be injected into an executor. Credentials are never accepted as tool arguments.
3. `registry rejected the credential ... (not_licensed | not_authenticated | license_inactive)` — the token has no entitlement for that `kitId`, or is not a registry bearer. Re-issue it from the AgentKit account that owns the licence.
4. `manifest signature did not verify` / `signed by key ...; pinned key is ...` — the registry signing key rotated or the pinned key is stale. Update `AGENTKIT_REGISTRY_KEY_ID` and `AGENTKIT_REGISTRY_PUBLIC_KEY` together; do not disable verification.
5. `package digest did not match the signed manifest`, `must contain exactly one <kitId> root directory`, or `outside the <kitId> root` — the downloaded artifact is not the published package. Retry once; if it persists, treat it as an upstream publish problem instead of mounting the content.
6. `no published release for kit <kitId>` — that kit has no signed release on the requested channel yet. Try `channel: "beta"`, or pin a version that exists.

### 16. Uploaded operator skills do not appear in `skills_list`
**Cause:** The `built-in` tier is populated only when the runner is pointed at an operator-owned host directory, and only reads a strict layout.
**Fix:**
1. Set `BUILTIN_SKILLS_ROOT` to an absolute host directory in the runner environment (`/etc/cloud-harness-mcp/runtime.env` or `.env`) and restart the stack; with the variable unset the executor mounts nothing and the tier stays empty by design.
2. Upload skills as `<root>/<skill-name>/SKILL.md`; a directory without `SKILL.md` is ignored.
3. Confirm the host path is readable by the runner and that the directory exists (`deploy/scripts/bootstrap-vps.sh` creates `/var/lib/cloud-harness/skills` on first install).
4. Remember the tier outranks project skills: a same-named `.agents/skills` or `.cloud-harness/skills` entry appears under `shadowed`, not as the selected skill.
5. Only changes to already-open workspaces need a reopen; a new workspace sees an updated upload immediately.
6. `BUILTIN_SKILLS_ROOT` is reserved and is now the single name the worker reads. If the runner rejects a stored secret or environment record with that name (`INVALID_INPUT`), remove it with `secret_delete` (deletion of a reserved name stays allowed) and reopen. The removed `CH_BUILTIN_SKILLS_ROOT` override is no longer read: rename it to `BUILTIN_SKILLS_ROOT`. A container created before this change keeps its old environment until it is closed or rebuilt.

### 17. `git_log` only shows one commit, or read-only GitHub calls prompt for approval every time
**Cause:** `workspace_open` clones a single commit by default, so a fresh workspace's history is one commit deep until deepened. Separately, MCP client approval prompts key off tool-level annotations: `github_action` is annotated destructive as a whole tool because it also performs mutations, so a client can prompt even for a read action like `pr_list` since there is no per-action server approval gate.
**Fix:**
1. For history depth, pass `fetchDepth` (0 for full history, or a commit count) or `shallowSince` (an ISO date/datetime) to `workspace_open`, or call `git_fetch` afterward with `depth`, `unshallow`, or `shallowSince`.
2. For GitHub reads, call the dedicated `github_read` tool (`pr_list`, `pr_view`, `pr_review_threads`, `pr_reviews`, `issue_list`, `issue_view`, `commit_list`, `compare`, `release_list`, `tag_list`, `ref_get`, `commit_status_get`, `check_runs_list`, `workflow_runs_list`, `workflow_run_view`) instead of `github_action`. It is annotated read-only/idempotent/non-destructive, so compliant clients do not prompt per call. `github_action` still accepts the same read actions for compatibility.

### 18. A skill is missing from `skills/list`, or `skills/get` returns `-32602`
**Cause:** The [Skills over MCP](/agent-toolkits#skills-over-mcp-native-client-skills) extension serves `built-in` skills and your own enabled library skills, adds one workspace's `workspace` and `repository` skills only on that workspace's `/mcp/workspaces/<workspaceId>` endpoint, and omits any skill it cannot serve whole and verified.
**Fix:**
1. Confirm the client supports the `io.modelcontextprotocol/skills` extension and is connected to the HTTP `/mcp` endpoint. Local stdio mode and `/mcp-gateway` do not offer it; use `skills_list` / `skills_read` there.
2. For workspace and repository skills, connect to `/mcp/workspaces/<workspaceId>` for that workspace, on the same host and with the same authentication as `/mcp` (the static API-key lane forwards only `/mcp` and `/mcp-gateway`, so it cannot reach this endpoint). If that URL returns an nginx `404` page while `/mcp` works, the host predates the route: the operator runs `sudo /usr/local/sbin/cloud-harness-upgrade-nginx` (Access-mode release deploys run it automatically). If that command exits `9`, the site already routes something else under `/mcp/`; reconcile it with `deploy/nginx/cloud-harness-mcp.conf` by hand and rerun. `-32602` "workspace is not available" means the workspace is not yours, does not exist, or is no longer open (closed, failed, or lease expired); open or recover it and reconnect. A `skill://cloud-harness/workspace/...` or `.../repository/...` URI works only on the endpoint of the workspace it names. Owner-scope toolkits passed to `workspace_open` are not served over the extension; use `skills_list` / `skills_read` for those.
3. Check that the library skill is enabled, not archived or disabled.
4. Check that `SKILL.md` is UTF-8 and starts with YAML frontmatter holding a `name` (1–120 letters, digits, `.`, `_`, or `-`) and a non-empty `description`. The URI uses that `name`.
5. Remove symbolic links and special files from the skill directory, keep it within 512 files, 16 MiB, and 32 nested directory levels, use UTF-8 file names, and keep every encoded file URI within 1024 characters (non-ASCII and spaces are percent-encoded, so long non-Latin paths reach it sooner).
6. Two skills with the same name and different content in the same tier conflict, and neither is served; the same applies when one of them cannot be read. In the `repository` tier, `.agents/skills` outranks `.codex/skills`, which outranks `.claude/skills`, so only same-root duplicates conflict. A same name in different tiers is served at each tier-qualified URI. A repository skill root reached through a symbolic link (for example `.agents` linked elsewhere) is ignored.
7. `-32603` asking you to re-run `skills/get` means a workspace or repository file changed after its manifest was computed; fetch the entry again and re-read. Any other `-32603` is a transient runner failure; retry. Clients may cache results for up to 30 seconds.

---

### 19. MCP Gateway: `AUTHORIZATION_REQUIRED` or an OAuth connection error
**Cause:** A downstream MCP server set to **Authenticate with OAuth** has no usable sign-in for you. This is Cloud Harness signing in **to** that server, not your AI client signing in to Cloud Harness (see items 5 and 6 for that). It happens before the first **Connect**, after **Disconnect**, after you change the server's endpoint or manual client, or when the provider refuses to renew the token. Gateway calls from your AI client never open a browser, so they report `AUTHORIZATION_REQUIRED`, and **Test** or **Refresh tools** report it as HTTP `409`.
**Fix:**
1. Open the server in [MCP Servers](/dashboard/mcp-servers) and select **Connect** or **Reauthorize** in the **OAuth** panel of the Overview tab, then retry the call.
2. If you return to the server page with an error, the `reason` names the cause:
   - `invalid_state` or `expired` — the sign-in link was already used, replaced by a newer **Connect**, or left too long. Select **Connect** again in the same browser.
   - `denied` — you or the provider declined the request. Check the scopes and the account you signed in with.
   - `issuer_mismatch` — the provider's response did not come from the expected authorization server. Do not retry blindly; confirm the endpoint is the vendor's real MCP URL.
   - `exchange_failed` — the provider rejected the sign-in completion. The **OAuth** panel shows the sanitized error; a wrong manual client ID or secret is a common cause.
3. If the **OAuth** panel reads **Not configured** (no **Connect** button) or **Connect** reports that MCP OAuth is unavailable, the operator must set `MCP_DOWNSTREAM_OAUTH_REDIRECT_URL` (see the [environment variables reference](/reference/environment-variables)).
4. If **Connect** fails before the provider's page opens, the provider may not support automatic client registration. Register a client with the provider and enter its **Client ID** (and a client-secret global secret, if it issued one) in the server form.

---

### 20. A managed agent ends `FAILED` with `agent bootstrap failed ... repositoryContext "none"`
**Cause:** Before an `agent_spawn` agent's first turn, the runner reads the workspace's repository guidance (`AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, `DESIGN.md`, client rule files) and places the applicable files ahead of the task. When that scan cannot complete (for example the executor is unavailable, or the workspace was closed or recreated meanwhile), the agent fails closed with an `UNAVAILABLE` reason instead of starting without guidance. No model lease or container was created for it.
**Fix:**
1. Check the workspace with `workspace_status`; recover or reopen it if it is not `ACTIVE`.
2. Retry `agent_spawn` with a new idempotency key. Replaying the failed key returns the failed record.
3. If the agent does not need repository guidance, spawn with `repositoryContext: "none"` to send the task alone.

If an agent started but followed the wrong files, read the `repository_context` event in `agent_logs`: it lists the injected and skipped paths with reasons (`not-targeted`, `overridden-by:...`, `duplicate-of:...`, `unreadable`, `client-configuration`, `context-budget`) and digests, never content. Choose the `repositoryContext` that matches the agent's guidance family, and compare with `workspace_context` for the same `clientProfile`, which applies the same selection. Rule files under `.claude/rules/` apply only to `claude`, and `.cursor/rules/` only to `cursor`. A `context-budget` skip means guidance and task exceeded a quarter of the agent's `maxInputTokens` (every model turn re-sends the first message); raise `maxInputTokens` or choose a narrower `repositoryContext`.

---

### 21. MCP OAuth sessions panel is read-only or shows a sync error
**Cause:** Dashboard → Settings → **MCP OAuth sessions** reads and writes the grant through the operator's Cloudflare API integration. **Last provider sync** shows a reason code when that fails; nothing is changed by a failed save unless the reason is `write_unconfirmed` or `readback_mismatch`.

**Fix:**

| Reason or state | What to do |
| :--- | :--- |
| No provider integration is configured | The grant is managed in Cloudflare Zero Trust only. An operator can add the runner-only `CLOUDFLARE_ACCESS_*` variables from the [environment-variable reference](/reference/environment-variables). |
| `provider_unreachable`, `provider_invalid_response` | Cloudflare could not be reached or answered unexpectedly. Wait, then use **Reload from provider**. |
| `provider_permission_denied`, `provider_write_denied` | The API token lacks **Access: Apps and Policies** Read or Write on the account. Replace the token and restart the runner. |
| `provider_application_not_found` | The configured account or Access application ID is wrong. |
| `provider_rejected` | Cloudflare refused the update. Try a shorter duration, or review the application in Cloudflare Zero Trust. |
| Configured read-only | Set `CLOUDFLARE_ACCESS_OAUTH_ACCESS=read-write` with a Write token to save here. |
| `provider_unsupported_application` | The application uses SCIM or is not self-hosted, so Cloud Harness will not rewrite it. Change the grant in Cloudflare Zero Trust. |
| `managed_oauth_disabled` | Turn on Managed OAuth for the application in Cloudflare Zero Trust. |
| `revision_conflict` | Someone changed the OAuth settings in Cloudflare after the page loaded. Reload and review before saving. |
| `write_unconfirmed` | The update timed out or failed on Cloudflare's side and may or may not have landed. Reload before retrying. |
| `readback_mismatch` | Cloudflare accepted the update but did not confirm it. Reload to see the values actually in effect. |
| **Set outside Cloud Harness** / **Changed outside Cloud Harness** | The value was customised in Cloudflare. Cloud Harness never overwrites it; choose **Adopt default** or save a value to manage it. |

---

### 22. Dashboard Terminal is unavailable or "No longer available"
**Cause:** [Dashboard terminals](/dashboard/terminal) live in the runner's memory and are never resumed. The most common causes are:

| Symptom | Meaning and fix |
| :--- | :--- |
| **No longer available** on an open terminal | The runner restarted, or the terminal was closed, timed out, or ended long enough ago to be discarded. Choose **New session**. Use a background task for work that must survive a restart. |
| **Timed out** | The terminal reached its idle timeout or maximum lifetime. Choose **New session**. |
| **No longer available**, "ended with its workspace" | The workspace was closed or expired, and its terminals ended with it. Renew or recover the workspace, then choose **New session**. |
| "Output stopped" under the terminal | The harness refused the output request, or it stayed unreachable through about a minute of retries. Reload the page, then re-attach the terminal from the Terminal tab if it is still running. |
| Opening fails with HTTP `429` and "too many open terminals" | The workspace already holds its limit of live terminals. Close one from the Terminal tab or [`/dashboard/terminals`](/dashboard/terminal#all-terminals), or ask the operator to raise `TERMINAL_MAX_PER_WORKSPACE` (see the [environment variables reference](/reference/environment-variables)). |
| "Unsent keystrokes were dropped" while typing or pasting | Input arrived faster than the shell accepted it, and in-order retries ran out. Wait for the shell to catch up, then send the rest again. |
| Opening fails with HTTP `503` while other workspace actions work | The workspace executor is not running, or the runner cannot reach Docker over a unix socket. Recover the workspace first. Operators: terminals require the runner's `DOCKER_HOST` to be unset or a `unix://` path. |

### 23. `bash` with `target: "toolbox"` returns `FORBIDDEN`, `LIMIT_EXCEEDED`, or `UNAVAILABLE`
**Cause:** The toolbox target runs each command in a fresh, network-less container from the executor image. Each error has one meaning:

| Error | Meaning and fix |
| :--- | :--- |
| `FORBIDDEN` | The operator has not enabled the toolbox. It is off unless `PACKAGES_ENABLED=true` (see the [environment variables reference](/reference/environment-variables)). Use `target: "workspace"` meanwhile. |
| `LIMIT_EXCEEDED` (HTTP `429`, retryable) | `TOOLBOX_MAX_CONCURRENT` toolbox commands are already running on this instance, sync and async together. Wait for one to finish, or cancel an async handle with `operation_cancel`, then retry. Operators can raise the limit. |
| `UNAVAILABLE` (HTTP `503`, retryable) | Docker could not create or start the toolbox container, or the runner could not read its state afterwards; the command did not report an exit code. Retry. If it persists, operators should check that the executor image exists on the host and that the runner can reach Docker. |

### 24. `packages_plan`, `packages_apply`, or `packages_remove` fails
**Cause:** Managed packages are planned, approved for one exact plan digest, then built in an isolated builder. Each error points to one step:

| Error | Meaning and fix |
| :--- | :--- |
| `FORBIDDEN`, "disabled on this instance" | Managed packages are off. Operators enable them with `PACKAGES_ENABLED=true` (see the [environment variables reference](/reference/environment-variables)). |
| `FORBIDDEN`, "has no Dashboard in owner-bearer mode" | `PACKAGES_APPROVAL_MODE=required` needs a Dashboard approver, and owner-bearer deployments have none. Operators either run with Cloudflare Access or set `PACKAGES_APPROVAL_MODE=none` deliberately. |
| `PACKAGE_APPROVAL_REQUIRED` | The plan is waiting for approval. Approve it on the Dashboard **Packages** page, then call `packages_apply` again with the same `planId` and `planDigest`. |
| `NOT_SUPPORTED` | `apt` and other system packages are not managed packages. Bake them into an executor image variant instead. |
| `UNAVAILABLE` naming a registry host | The provisioning proxy refused that host. Operators add it to `PACKAGES_PROXY_HOSTS` in the provisioning-proxy environment and restart the proxy. |
| `packages_plan` returns `state: "RESOLVING"` with a `resolutionId` | Not an error. Resolution took longer than the plan call waits (a cold uv toolchain or a large npm tree) and keeps running. Poll `packages_status` with that `resolutionId` and a `waitMs` until it is `READY` (the plan is included) or `FAILED` (with `errorCode` and `errorMessage`). |
| `NOT_FOUND`, "plan resolution not found" | Resolutions are kept only in runner memory: the runner restarted, the resolution finished more than 30 minutes ago, or enough newer resolutions finished to replace it. Run `packages_plan` again. |
| `UNAVAILABLE`, "the runner is shutting down" | The runner is restarting (for example during a deploy). Retry the plan or apply once it is back. |
| `STALE_GENERATION` | The `planDigest` does not match the current plan, the executor image changed since the plan was made (for example after a redeploy), or the plan was approved by policy and the operator has since switched `PACKAGES_APPROVAL_MODE` to `required`. For `packages_rollback` or `packages_remove`, the binding changed since you read it. Review the plan or list packages again, then retry with current values. |
| `EXPIRED` | Plans expire 30 minutes after they are made. Create a new plan. |
| `CONFLICT`, "binaries collide" | Another binding in the same scope already provides a command with that name. Roll back, replace, or uninstall that binding (`packages_remove`) first. |
| `CONFLICT`, "an apply for this package and scope is in progress" | `packages_remove` waits for no build. Let the apply finish (`packages_status`), then remove. |
| `LIMIT_EXCEEDED`, "package build limit reached" (HTTP `429`, retryable) | Two builds are already running. Wait for one to finish, then retry. |
| `LIMIT_EXCEEDED`, "owner package storage quota would be exceeded" or "maximum of … package bindings" | The owner's release bytes or binding count are used up. Uninstall packages you no longer need with `packages_remove` (or **Uninstall** on the Dashboard [Packages](/dashboard/packages) page), then plan again. |
| `PACKAGE_BUILD_FAILED`, "only wheels are supported" | uv installs pre-built wheels only and never builds a source distribution, so planning runs no package code. The package or one of its dependencies has no wheel for the managed Python. Pin a version that ships wheels, or install it in a workspace with `uv` instead. |
| `PACKAGE_BUILD_FAILED` / `PACKAGE_VERIFICATION_FAILED` | The install failed, or the built tree or a binary's launch check did not pass. `packages_status` shows the redacted output tail. Pin a different version or ask for lifecycle scripts only when the package truly needs them. |

### 25. A merge-train routine: `git_push` lock returns `CONFLICT`/`FORBIDDEN`, or a dispatched run cannot be found
**Cause:** Leased `git_push` calls are atomic on GitHub's side, so they report the remote's real state instead of retrying. Workflow dispatch is asynchronous and GitHub returns no run ID for it.
**Fix:**
1. `CONFLICT` on `expectedAbsent: true` means another holder created the lock branch first; on `expectedRemoteOid` (update or `delete: true`) it means the branch moved. Read the branch with `github_read` `ref_get`, then wait or take the new value as your next lease. `CONFLICT` on a create-only push also appears when the lock already holds the very commit you pushed: two holders pushing the same `HEAD` cannot both win, so push a commit unique to the holder (see [Git transfer](/reference/git-transfer)). After `UNKNOWN_REMOTE_STATE`, retry with the same `idempotencyKey`: a lock that already holds your refspec source's commit returns `alreadyFinalized: true`, and `CONFLICT` carries `currentRemoteOid` to compare with the commit you pushed.
2. `FORBIDDEN` "rejected by the remote's branch protection, ruleset, or hook" (`[remote rejected]`, `GH006`, `GH013`) is a policy refusal and is not retryable: the target branch requires passing checks, a pull request, or a bypass entry for the App. `GITHUB_PERMISSION_MISSING` on a push means the commit changes `.github/workflows` and the App lacks **Workflows: Read and write**.
3. After `workflow_dispatch`, poll `github_read` `workflow_runs_list` with the returned `runLookup` (`workflow`, `headSha`, `event: "workflow_dispatch"`) for a few seconds until the run appears.
4. A routine that keeps one workspace for about an hour needs `WORKSPACE_WALL_TTL_SECONDS` of at least `3600`, because `workspace_lease_renew` never extends past the wall-clock deadline (`hardExpiresAt`). A renewal the deadline caps returns `leaseCapped: true`, `requestedExpiresAt`, and a `leaseWarnings` entry, so check `leaseCapped` instead of `ok` before a long step. Alternatively open a fresh workspace (a `fetchDepth: 1` checkout is enough for brokered GitHub calls) for each phase.

---

### 26. ChatGPT does not receive task or agent events, or `events/subscribe` fails
**Cause:** [MCP Events](/ai-tools/chatgpt#_3-task-and-agent-notifications-mcp-events) are offered only on the remote `/mcp` endpoint, are delivered to the client's own HTTPS callback, and are never replayed.
**Fix:**
1. Connect to `https://harness.zuey.me/mcp`. Local stdio mode and `/mcp-gateway` do not offer events.
2. Check the subscription's state, last error category, and recent deliveries with `GET /dashboard/api/v1/event-subscriptions`.
3. `-32015` means the callback failed the signed verification challenge (unreachable, timed out, TLS error, non-`2xx` or redirect response, or a wrong `challenge` echo); nothing was stored. `-32602` means the callback is not a public `https` URL or the secret is not a valid `whsec_` secret. `-32012` means the request was not authenticated or a filter names a workspace, task, or agent you do not own; `-32013` means the subscription quota is reached.
4. A subscription created with an API key stops when that key is revoked or expires; subscribe again with a valid credential.
5. An event that happened before the subscription existed, or after it lapsed, is never delivered. Read the result with `tasks_status` or `agent_status`.
6. Receivers may see the same event twice; deduplicate on the `webhook-id` header.

---

### 27. MCP gateway `search` says `ranking: "lexical"` although semantic routing is on, or a GitHub error has no `diagnosis`
**Cause:** The Decision Plane is advisory and falls back silently to the deterministic result. That happens when the purpose is not listed in `DECISION_PLANE_PURPOSES`, `TYPESAFE_EGRESS=off`, the owner has no TypeSafe key, the provider timed out or was rate limited, the answer was malformed or low-confidence, or fewer than two tools matched lexically. A `diagnosis` is attached only to failures the deterministic classifier could not name (`GITHUB_ACTION_FAILED`). For agent policies, the same causes make an **Advisor or approval** action wait for approval (or deny it, if the policy says so), and the decision names the reason, for example `Jev not consulted (no TypeSafe key)`; the `execution-risk` purpose also needs the advisor enabled in the global agent policy.
**Fix:**
1. Read `GET /api/v1/decision-plane/status`. `enabled` and `purposes` show what is on, `configured` shows whether this owner has a key, and `metrics.<purpose>.fallbackReasons` counts why calls fell back.
2. Search the audit log for `decision.evaluated` rows. Each one carries the `outcome` and `fallbackReason` without any prompt text.
3. Lexical results are always correct to use. A fallback is never an error.

---

### 28. An expired workspace is not auto-closed, and its `error` starts with `auto-close deferred:`
**Cause:** The recoverable grace passed, but closing the workspace would have lost work: agents were still running, or the checkout had uncommitted or untracked files, stashes, or commits on a local branch that is not on any remote. A check that could not run defers the close too. Earlier releases deleted recoverable workspaces after one hour regardless; auto-close now retains them, and the reaper retries after the longer of the grace and one hour.
**Fix:**
1. Call `workspace_recover` with `mode: "status"` or `"patch"` to see what is unsaved.
2. Push it (resume with `workspace_recover`, then `git_push`) or use `mode: "export"` to push a recovery snapshot branch.
3. Call `workspace_close`. Closing without saving first discards the work.
**Retained by auto-close** in Dashboard → [Settings](/dashboard/settings#workspace-limits-lifecycle) counts these workspaces; they no longer count against the active quota but still use disk.

---

### 29. An agent's model request fails with `400 invalid_model_request` naming a field or tool type
**Cause:** The Model Gateway charges every request against the agent's budget before sending it, and it keeps the agent inside its workspace's network profile. It refuses anything it cannot measure, and anything that would make the provider act for the agent. The error message names the refused field or tool type:
- stored Responses context: `previous_response_id`, `conversation`, or an object-valued `prompt` (a stored prompt template);
- any tool type other than the agent-run `function` and `custom` tools, such as the provider-hosted `web_search`, `file_search`, `code_interpreter`, `image_generation`, `mcp`, or `computer_use`. A hosted web search or remote MCP tool would let an agent in a `network-none` workspace reach the network through the provider;
- the fields `plugins` and `web_search_options`, which turn on provider-side web search on either API;
- image, audio, video, or file parts that point at a `file_id` or at a URL other than a `data:` URL, because the provider would download that content for the agent.

**Fix:**
1. The built-in agent runtime sends the full input on every turn, uses only function tools, and never sends these fields. If you see this error, a custom runtime or tool added one of them.
2. Send the full conversation as `input` on each request, and send the prompt text inline instead of a stored prompt ID.
3. Run tools in the agent as function or custom tools, and send images, audio, video, and files inline as a `data:` URL or base64.

---

### 30. `agent_spawn` fails with `LIMIT_EXCEEDED: model spend policy (...) would be exceeded`
**Cause:** The owner has set a daily or monthly model spend policy, for the whole account or for one model profile. Every spawn reserves its whole `maxCostMicros` against the policies that apply, in UTC days and months, and this spawn's cap does not fit in what is left. A running agent counts at its full cap until it ends; then it counts at what the model gateway charged. A run whose gateway accounting was lost, for example to a gateway restart, keeps counting at its full cap and is marked unreconciled. All of these amounts are estimates, not provider billing: a run counts entirely in the window it was admitted in, so spend near a day or month boundary can exceed one window's limit. The error is marked not retryable because retrying unchanged right away fails the same way. The error message names the policy, the estimated amount already committed, and the headroom left. The refused spawn created no agent, so nothing needs cleaning up.

**Fix:**
1. Lower `maxCostMicros` to fit the headroom named in the message, or wait for running agents to finish, then retry. The refused spawn recorded nothing, so the same idempotency key can be reused.
2. If the limit is too tight, the owner can raise or remove the policy through the dashboard's spend routes; see [Spend policies](/dashboard/models#spend-policies). No MCP tool changes policies; `model_spend_summary` only reads them, with the estimated spend in each window.

Per-run caps are unchanged: a policy never raises or clamps an agent's own `maxCostMicros`, which the model gateway still enforces.

---

### 31. `model_profile_create`, `model_profile_update`, or `model_connection_verify` returns `OWNER_APPROVAL_REQUIRED`
**Cause:** An MCP client may prepare model profiles, but a change that raises spend capacity, widens what agents may do, or sends a key to a new host needs the owner. The message lists the refused escalations:

| Escalation | What triggered it |
| :--- | :--- |
| `limits_raised` | A token or cost limit above the current revision's. |
| `price_lowered` | A lower price that is not pinned from the catalog (`catalogPriceRef`). |
| `credential_changed` | An update that moves the profile to another provider credential. |
| `price_unverified_for_new_route` | Override prices carried to another model or credential. |
| `proxy_operations_widened` | A proxy operation the current revision does not allow. |
| `custom_upstream_unbound` | A Custom credential's upstream URL that none of your profiles on that credential uses yet, on a create, an update, or a draft connection check. |

Nothing was saved or sent to the provider; the refusal is recorded in the audit log with the actor `mcp`. It is not retryable: the same call fails the same way. A refused call does not spend its `idempotencyKey`.

**Fix:**
1. Run `model_profile_validate` with the same change: its `escalations` list shows exactly what a save would refuse. Drop those fields to save the rest over MCP.
2. Otherwise, ask the owner to make the change on the Dashboard [Models page](/dashboard/models), where the same change is saved. Once the owner has saved a profile on a Custom upstream URL, MCP calls may use that URL with that credential.
3. A profile created over MCP starts **Disabled**. `agent_spawn` cannot use it until the owner activates it on the Models page; no MCP tool activates, disables, or deletes a profile.

---

### 32. GitHub automation deliveries fail, or no run starts
**Cause:** A [webhook automation](/dashboard/automations) delivery is refused before it reaches a rule, or it reaches the rules and none of them starts a run. GitHub's webhook **Recent Deliveries** view shows the response; the Dashboard **Automations → Deliveries** view shows what happened next.
**Fix:**
1. `404` or an nginx page: automations are off on the API (`AUTOMATIONS_ENABLED`), or the server is missing the managed `/integrations/webhooks/` nginx route. A Cloudflare Access login page means Access is protecting the path; the operator must add an Access bypass for `/integrations/webhooks/` only.
2. `401`: the connection id in the URL is wrong, the connection is disabled or deleted, or the secret does not match. The response is the same for all of these on purpose. After **Rotate secret**, paste the new secret into GitHub; old signatures are refused immediately.
3. `415`: set the GitHub webhook content type to `application/json`.
4. `429`: too many deliveries in a minute. GitHub does not retry by itself; use **Redeliver** in GitHub after a minute.
5. `503`: the runner is not answering, has automations off while the API has them on, or has no secret keyring. Ask the operator to check both services.
6. `202` with `ignored`: the event is not a label addition on an issue or pull request (GitHub's `ping` is always ignored), or the body was malformed (listed as quarantined).
7. Processed but no run: the delivery's outcome names the reason, such as `no_matching_rule`, `bot_sender`, `self_trigger`, `actor_not_allowed`, `coalesced` (a run for that issue is already active), or `cooldown`. Check that the rule is enabled and use **Test event** on it.
8. A run ends `FAILED`, `EXPIRED`, or with **Publish failed**: its error code names the step. A private repository or a comment needs the [GitHub App](/dashboard/github) to have access to that repository (and issue write access for comments).

---

### 33. Multi-repository workspace: `needs repositoryId`, `is read-only`, or a repository-limit `LIMIT_EXCEEDED`
**Cause:** A workspace opened with `repositories` holds one checkout per alias under `repos/<alias>/`, and some tools need to know which one you mean.
- `INVALID_INPUT: <tool> needs repositoryId in a multi-repository workspace` comes from a Git, worktree, `workspace_finalize`, `workspace_recover` `export`, `github_read`, or `github_action` call without a selector. These tools never guess, so a commit or push cannot land in the wrong repository.
- `FORBIDDEN: repository <alias> is read-only in this workspace` means that repository was opened with `access: "read-only"`, which refuses pushes, pushing finalizes, recovery exports, and GitHub write actions for it.
- `LIMIT_EXCEEDED: a workspace holds at most N repositories on this instance` means the `repositories` set is larger than the operator's `MAX_WORKSPACE_REPOSITORIES`.
- `repository <alias>: ...` on `workspace_open` means that repository's clone failed. The whole open fails and no checkout is kept.
- `repositoryId is unsupported in local mode` means you are on a local stdio server, which has one directory per workspace.

**Fix:**
1. Call `workspace_repos_list` and pass the `alias` or `repositoryId` it returns as `repositoryId`.
2. To push to a read-only repository, open a new workspace that lists it as `read-write`. Access is fixed when the workspace opens.
3. Open fewer repositories, or ask the operator to raise `MAX_WORKSPACE_REPOSITORIES` (see [Environment Variables](/reference/environment-variables)).
4. For a failed clone, fix that repository's URL, ref, or access, then open again with a new idempotency key.

File and command tools without `repositoryId` work on the workspace root, so paths start with `repos/<alias>/`. `read-only` is not isolation: commands in the workspace can still change files in every checkout.

### 34. Agent traces: `FEATURE_DISABLED`, `TRACE_EXPIRED`, `NOT_FOUND`, or a trace marked `unreconciled`
**Cause:**
- `FEATURE_DISABLED` (409) from any `agent_trace*` tool, or no **Traces** entry in the Dashboard sidebar, means the operator has not set `AGENT_TRACES_ENABLED=true` on the runner.
- `TRACE_EXPIRED` (410) means retention or the per-principal quota removed the trace, or the trace a list cursor continued from.
- `NOT_FOUND` means the trace does not exist or belongs to another identity; the two are reported the same way on purpose.
- `unreconciled` means the model-call spans and the agent usage ledger disagree beyond the rounding tolerance. Its `reasons` name why, for example usage missing from a model call or `recorder_degraded` when a trace write failed during the run.

**Fix:**
1. Ask the operator to enable agent traces (see [Environment Variables](/reference/environment-variables)). Runs from before the flag was on have no trace.
2. For `TRACE_EXPIRED` on a list, start the listing again without a cursor. To keep traces longer, ask the operator to raise `AGENT_TRACE_RETENTION_DAYS`.
3. Copy `traceId` exactly from a list result under the same identity that ran the agent.
4. Treat an `unreconciled` trace's totals as approximate; `agent_status` usage and the gateway settlement on the trace are the reference figures.