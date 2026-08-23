---
phase: 5
title: "Fork Branch VPS Test Deployment"
status: pending
priority: P1
effort: ""
dependencies: [3, 4]
---

# Phase 5: Fork Branch VPS Test Deployment

## Overview

Push reviewed owner-fork branches and deploy exact commits into fully isolated Cloud Harness, static API-key gateway, and WAB gateway-only test stacks. Production services remain running and untouched. Live host/Cloudflare operations require fresh explicit authorization after Phase 1 passes.

## Requirements

- Separate checkouts, Compose projects, images, labels, state/data roots, secrets, loopback ports, hostnames, Cloudflare Access applications, Worker gateway, and ChatGPT draft app.
- Full two-lane Cloud Harness auth:
  - ChatGPT OAuth endpoint for model/widget profile.
  - Static API-key Worker endpoint with path-scoped service assertion for WAB service profile.
- WAB managed API key is created through the same authenticated ChatGPT external principal and verified by matching opaque `mailboxId` over both transports.
- Server-side caller profiles/registries and read-only model allowlist are active.
- WAB mailbox container starts only the gateway process: no Xvfb, x11vnc, websockify/noVNC, Chrome, browser profile mount, DISPLAY, or port 6080.
- Cleanup includes exact runner-instance-labeled executor/helper containers, not Compose labels alone.
- No production secret/key/state/repository credential reuse.

## Proposed Isolation

Provisional pending owner approval:

```text
Cloud Harness branch: feat/chatgpt-mailbox-runtime-mvp
repo:                 therichardngai-code/cloud-harness-mcp
checkout:             /opt/clawboxes/cloud-harness-mailbox-mvp
data:                 /opt/clawboxes/cloud-harness-mailbox-mvp-data
Compose project:      cloud-harness-mailbox-mvp
loopback ingress:     127.0.0.1:3110
OAuth hostname:       harness-mailbox-mvp.goclawoffice.app
static gateway host:  api.harness-mailbox-mvp.goclawoffice.app

WAB branch:           feat/cloud-harness-mailbox-provider-mvp
repo:                 therichardngai-code/wab
checkout:             /opt/clawboxes/wab-mailbox-mvp
Compose project:      wab-mailbox-mvp
loopback ingress:     127.0.0.1:3221
hostname:             wab-mailbox-mvp.goclawoffice.app
```

Separate secrets:

```text
runner token
mailbox encryption keyring
Cloudflare Access OAuth audience/config
static gateway Access audience + service subject
Worker service-token client ID/secret
principal-bound managed mailbox API key
WAB client API key
```

## Related Code And Operations

### Cloud Harness

- Add isolated mailbox MCP/profile routes without changing production route discovery.
- Configure separate Access applications for OAuth and exact hidden static-key origin path.
- Deploy an isolated copy/configuration of `apps/api-key-gateway` with its own Worker route and service token.
- Use test-only Compose overrides and paths owned by the branch.

### WAB

- Create a gateway-only entrypoint/service or lightweight Dockerfile.
- Start `node dist/src/index.js` mailbox compatibility mode only.
- Omit supervisor, DISPLAY, profile bootstrap/mount, Chrome packages/process, noVNC packages/process/port.

## Implementation Steps

1. Review both branch diffs and record exact SHAs. Push only owner branches.
2. Obtain explicit authorization for exact VPS paths, ports, hostnames, Caddy edits, Cloudflare apps/Worker/service token, and service starts.
3. Clone/fetch exact branch commits into new paths; verify ancestry and checkout exact SHAs, never unreviewed pull.
4. Generate independent mode-0600 test secrets and state roots without printing them.
5. Start isolated Cloud Harness Compose project with unique jobs/state/artifact roots and instance identity. Omit production GitHub App credentials/repository grants.
6. Configure OAuth test hostname/Access application with exact ChatGPT callback allowlist.
7. Configure the second path-scoped static-key Access application/audience, gateway service subject, Worker route, and service-token credentials exactly as the existing deployment contract requires.
8. Authenticate the ChatGPT draft app first. Through that same dashboard principal, create the managed WAB test key.
9. Call `mailbox_status` through ChatGPT OAuth/widget and WAB static service lane. Compare only the sanitized opaque mailbox ID and abort on mismatch.
10. Build/start WAB gateway-only image. Assert no Chrome/X11/VNC processes, mounts, env, or published port exist.
11. Validate Caddy before any authorized reload and verify production routes remain unchanged.
12. Scan/refresh only the draft ChatGPT app. Confirm model discovery shows mailbox model tools + read-only allowlist, not mutating operations.
13. Invoke `mailbox_open`, request PiP, and verify current consumer generation/poll state.
14. Before/after each test stack change, verify production Cloud Harness/WAB health and container/state ownership.
15. Record isolated runner instance ID and exact project labels for cleanup.

## Success Criteria

- [ ] Test stacks have unique projects, paths, ports, identities, data, and secrets.
- [ ] OAuth and static-key lanes both authenticate and resolve the same mailbox ID.
- [ ] WAB reaches the public static gateway through service assertion + managed key; no hidden-origin shortcut exists.
- [ ] Model discovery/dispatch excludes all mutating existing tools.
- [ ] WAB process list/mounts/ports contain no browser/noVNC surface.
- [ ] Draft app mounts widget and consumer is online.
- [ ] Production state/services remain unchanged.
- [ ] No production GitHub App/API key/keyring/state is mounted.

## Rollback

1. Resolve and record the isolated runner instance ID from its state before stopping services.
2. Stop/remove only executor/helper containers with that exact `cloud-harness.instance` label.
3. Stop only `cloud-harness-mailbox-mvp` and `wab-mailbox-mvp` Compose projects; verify project labels before removal.
4. Remove test Caddy/DNS/Access/Worker routes only after validating production routes.
5. Revoke test managed API key, Worker service token, OAuth app, and draft ChatGPT app.
6. Preserve test state until evidence acceptance; delete only with explicit authorization.
7. Verify no test instance/project containers remain and production readiness/OAuth/dashboard/WAB remain healthy.

## Risk Assessment

- **Missing static auth hop:** deployment cannot proceed until Worker/service-token lane passes an auth-only smoke.
- **Principal mismatch:** mailbox ID comparison blocks WAB enqueue.
- **Browser surface accidentally retained:** gateway-only process/image assertion is mandatory.
- **Shared Docker daemon cleanup:** exact runner instance labels plus Compose labels; no prune/broad cleanup.
- **Live blast radius:** every host/Cloudflare mutation requires fresh explicit authorization.
