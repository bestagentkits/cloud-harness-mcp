---
title: Instance Settings
description: Instance-wide workspace defaults, network egress readiness, the credential-exfiltration tradeoff, and MCP OAuth session lifetimes.
---

# Instance Settings

The Settings page (`/dashboard/settings`) owns the instance-wide defaults that apply to workspaces opened without an explicit override. It exposes the default executor network profile and the MCP OAuth session lifetimes.

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
