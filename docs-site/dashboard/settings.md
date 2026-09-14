---
title: Instance Settings
description: Instance-wide workspace defaults, network egress readiness, and the credential-exfiltration tradeoff.
---

# Instance Settings

The Settings page (`/dashboard/settings`) owns the instance-wide defaults that apply to workspaces opened without an explicit override. It currently exposes the default executor network profile.

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
