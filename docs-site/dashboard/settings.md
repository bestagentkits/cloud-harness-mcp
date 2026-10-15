---
title: Instance Settings
description: Instance-wide workspace defaults, workspace limits and lifecycle, network egress readiness, the credential-exfiltration tradeoff, MCP OAuth session lifetimes, and the TypeSafe integration key.
---

# Instance Settings

The Settings page (`/dashboard/settings`) owns the instance-wide defaults that apply to workspaces opened without an explicit override. It exposes the default executor network profile, the workspace quota and lifetimes, the MCP OAuth session lifetimes, and your TypeSafe integration key.

## Default Network Profile

A workspace opened without `networkProfile` resolves its posture in this order:

1. the `networkProfile` passed to `workspace_open`;
2. the default saved on this page;
3. the runner's `WORKSPACE_NETWORK_PROFILE` value, or the built-in default `dependency-access` when the variable is unset.

| Profile | Effect |
| :--- | :--- |
| `dependency-access` (built-in default) | Permits public DNS and TCP 80/443 through an attested Linux host firewall, so a workspace can reach the GitHub API and the bundled `gh` CLI. Loopback-to-host, Docker/control-plane, RFC 1918, link-local, and cloud-metadata ranges are blocked. |
| `network-none` | Blocks all executor egress. Use it to isolate a workspace or the whole instance. |

`dependency-access` is not an allowlist or DLP boundary: it still permits exfiltration to public endpoints. It fails closed with `DEPENDENCY_EGRESS_UNAVAILABLE` when the host firewall is not provisioned and is never silently downgraded to `network-none`.

The page shows the effective value and its source — **Set in this dashboard** when the value comes from this page, otherwise the runner default.

## Reset to the runner default

**Save** writes the selected value as the instance-wide default. **Reset to runner default** clears it, so `WORKSPACE_NETWORK_PROFILE` (or the built-in default) applies again. Neither action starts, stops, or changes a running workspace; the new default applies to workspaces opened afterwards.

## Egress readiness check

**Check egress readiness** runs an on-demand attestation of the managed bridge and host firewall and reports `Ready`, or `Not ready` with the probe's reason. Workspaces on `dependency-access` fail closed while readiness is not ready, because the runner also attests the profile before every executor start and quarantines a workspace whose network drifts.

## Credential warning

Dependency access grants outbound network access to repository-controlled code. Any credential injected into such a workspace — including a global `GH_TOKEN` or `GITHUB_TOKEN` runtime secret — can then be exfiltrated by a dependency, build script, or agent command. Prefer a fine-grained token scoped only to the repositories a workspace needs, or keep the instance default, or the individual workspace, on `network-none`. See [Secrets & Credentials](/dashboard/secrets) for the injection boundary.

## Upgrading an existing deployment

A deployment whose `.env` still pins `WORKSPACE_NETWORK_PROFILE` keeps that value: the environment default outranks the built-in one, so the shipped `dependency-access` default does not take effect until the operator clears the variable or saves a new default on this page. Before relying on egress by default:

1. Provision the host firewall with `deploy/scripts/setup-dependency-firewall.sh`.
2. Confirm **Egress readiness** on this page reports `Ready`.
3. Save `dependency-access` here, or edit the variable and restart the runner.

Enabling egress on a host without the firewall makes every dependency-access open fail with `DEPENDENCY_EGRESS_UNAVAILABLE` rather than silently downgrading. Provision the firewall, or select `network-none` and **Save** to keep opening workspaces without egress. **Reset to runner default** is not an opt-out: it clears the instance setting, so a host whose runner default is `dependency-access` goes back to requiring egress.

## Workspace limits & lifecycle

This panel changes the workspace quota and lifetimes without a redeploy. Each value resolves in this order: the override saved here, then the runner environment variable, then the built-in default. The panel shows the effective value, its source (**Dashboard override**, **Runner environment**, or **Built-in default**), the runner value a reset would restore, and the allowed range.

| Setting | Runner variable | Built-in default | What it decides |
| :--- | :--- | :--- | :--- |
| **Max active workspaces per principal** | `MAX_ACTIVE_WORKSPACES_PER_OWNER` | 3 | How many counted workspaces (`CREATING`, `ACTIVE`, `NETWORK_QUARANTINED`) one principal may hold. |
| **Idle timeout** | `WORKSPACE_IDLE_TTL_SECONDS` | 5 min | How long a workspace may go without workspace activity before it expires. `workspace_list`, `workspace_status`, and Dashboard polling do not count as activity. |
| **Maximum workspace lifetime** | `WORKSPACE_WALL_TTL_SECONDS` | 15 min | A hard deadline from creation that activity never extends. The idle timeout may not exceed it. |
| **Recoverable grace before auto-close** | `WORKSPACE_RECOVERABLE_GRACE_SECONDS` | 60 min | How long an expired workspace stays recoverable with `workspace_recover` before the reaper may close it. |

The durations are edited in whole minutes. The exact ranges are in the panel; the overrides' bounds are owned by `packages/contracts/src/workspace-lifecycle.ts`.

**Not retroactive.** Idle timeout, lifetime, and grace are fixed on each workspace when it opens, so a change applies only to workspaces opened afterwards. The quota is checked at the next open, recover, or lease renew; lowering it below current usage blocks new opens but never closes an existing workspace.

**Auto-close keeps unsaved work.** An expired workspace is closed at about expiry + grace + one reaper interval (the panel shows the interval), but only if nothing would be lost. Running agents, uncommitted or untracked files, stashes, or commits that are not on any remote keep it recoverable (commits sent with `git_push` count as on the remote; Git-ignored files are not checked and are deleted with the workspace); its `error` then starts with `auto-close deferred:` and the panel counts it under **Retained by auto-close**. Recover and push or export the work, then close it with `workspace_close`. A grace of 0 closes clean expired workspaces on the next reaper pass, so saving it requires ticking the acknowledgement.

**Capacity.** The panel shows your own counted and recoverable workspaces. Each executor is capped at 1 GiB of memory, one CPU, and 256 pids. These are ceilings, not reservations, and they multiply with every concurrent workspace, so size the host before raising the quota.

**Save lifecycle settings** sends only the fields you changed; **Reset to runner values** clears every override. If someone else saved the panel after you loaded it, the save is refused; reload and try again. Changes apply to the whole instance and are recorded in the [Audit log](/dashboard/audit) as `settings.workspace_lifecycle.changed`. These settings are separate from the MCP OAuth session lifetime below and from agent task TTLs, and no MCP tool can read or change them.

## MCP OAuth sessions

This panel controls how long an MCP client on the Managed OAuth lane, such as ChatGPT or Claude, stays signed in after one browser login. It manages two values of the Cloudflare Access application that protects `/mcp`:

| Setting | What it decides |
| :--- | :--- |
| **Stay signed in** / **Grant duration** | The OAuth grant (refresh) session: how long a client keeps working before it must sign in interactively again. **Stay signed in** uses the provider maximum, 30 days by default. Turn it off to pick a 1-, 7-, or 14-day preset or a custom number of hours. |
| **Advanced → Access-token lifetime** | How long each access token lasts, 1–60 minutes, default 15. Every silent refresh re-checks your Access policy, so revoking someone takes effect at their next refresh. A longer token does not reduce sign-ins; it only delays that re-check. |

The browser session for this dashboard is a separate Access setting and is not changed here.

The panel always shows what Cloudflare reports, not what was last typed:

- **Grant duration (effective)** and **Access-token lifetime (effective)** come from the provider read-back.
- **Management** is one of: not managed (no provider integration), set outside Cloud Harness and left unchanged, managed by Cloud Harness, or changed outside Cloud Harness since the last save.
- **Last provider sync** shows when Cloud Harness last read Cloudflare, and the failure reason if it could not.
- A warning explains why the panel is read-only when it is.

**Save OAuth settings** writes both values and reports success only after Cloudflare confirms them. If the configuration changed in Cloudflare after the page loaded, the save is refused; use **Reload from provider** and review. Saves apply to the whole instance and are recorded in the [Audit log](/dashboard/audit) as `settings.oauth_grant.changed`. Whether a new duration also applies to grants Cloudflare has already issued is decided by Cloudflare.

On a new install whose grant duration was never set, Cloud Harness applies the provider maximum at startup; **Management** then says the default was applied automatically at first start. It never overwrites a value someone already set in Cloudflare, including an access-token lifetime outside 1–60 minutes; instead the panel offers **Adopt default** to switch to the provider maximum with 15-minute tokens.

The panel is read-only, with the reason shown, when no integration is configured, the integration is read-only, Managed OAuth is off for the application, or the application uses SCIM provisioning or is not self-hosted. In those cases change the values in Cloudflare Zero Trust under **Advanced settings → Managed OAuth**. Operators enable the integration with the runner-only `CLOUDFLARE_ACCESS_*` API variables in the [environment-variable reference](/reference/environment-variables), using a Cloudflare API token limited to one account with **Access: Apps and Policies Write** (or **Read** for a read-only panel). The token never reaches the API, the browser, or a workspace. For sync errors, see [Troubleshooting](/troubleshooting#_21-mcp-oauth-sessions-panel-is-read-only-or-shows-a-sync-error).

## TypeSafe integration

The last panel stores your write-only TypeSafe API key and shows whether it is configured, whether the operator left TypeSafe egress on, and the endpoint and model in use. The key is per owner, unlike the instance-wide values above. See [TypeSafe Integration](/dashboard/typesafe).
