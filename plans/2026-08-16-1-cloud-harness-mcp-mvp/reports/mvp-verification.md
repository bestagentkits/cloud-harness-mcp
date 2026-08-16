# Cloud Harness MCP MVP verification

Date: 2026-08-16  
Result: **GO for private, single-owner operation**

## Release identity

- Repository: <https://github.com/bestagentkits/cloud-harness-mcp> (public, MIT, default branch `main`).
- Final verified release: `474b6ee3c2cac36460bcc3c92d6f18243e16e876`.
- Previous known-good release: `a9693ddca779efe3fae5b501a3e3991b0b55d050`.
- Endpoint: <https://cloud-harness-mcp.46-250-239-227.sslip.io/mcp>.
- Certificate expiry observed on the VPS: `2026-11-14 13:30:12 UTC`.

Recorded production image IDs:

- API: `sha256:25890d16d897c9be6039e10fcc51501eb78cccbe1572c3e20b3210870b7c7167`.
- Runner: `sha256:40f1817a9db9e760c7b86dcf0a832029784b9fb793884ed88e5c1de3d891514b`.
- Executor: `sha256:5d7c137299915acc99ef00f7aef595ca2e22092654690c774f7ee8cfbffbf4dc`.

The deploy pipeline validates an exact commit on `origin/main`, builds it on the VPS, and records local image IDs. It does not yet promote an externally attested registry digest.

## CI and deployment evidence

- Final CI: [run 31956028004](https://github.com/bestagentkits/cloud-harness-mcp/actions/runs/31956028004) — success for quality and Docker integration.
- Final automatic deployment: [run 31956134582](https://github.com/bestagentkits/cloud-harness-mcp/actions/runs/31956134582) — success.
- First known-good deployment: [run 31955763871](https://github.com/bestagentkits/cloud-harness-mcp/actions/runs/31955763871) — success.
- Earlier CI baseline: [run 31953468426](https://github.com/bestagentkits/cloud-harness-mcp/actions/runs/31953468426) — success.

The final CI ran lint, type checking, unit/integration tests, build, Compose boundary validation, image builds, a non-root runtime-file access check, real Docker isolation, end-to-end workflow, and managed-container cleanup. Final unit/integration evidence was 11 test files and 20 tests passing; Docker isolation and E2E passed in CI.

## Live protocol and workflow verification

The official MCP TypeScript SDK connected through public nginx/TLS using modern `2026-07-28` negotiation and legacy initialized 2025 Streamable HTTP compatibility. The committed production verifier returned:

```json
{
  "unauthorizedRejected": true,
  "modernProtocol": true,
  "legacyProtocol": true,
  "toolSurfaceConsistent": true,
  "workflow": true,
  "cleanup": true,
  "privateGitHubAppClone": "not-run-without-owner-supplied-credentials"
}
```

A separate live full-surface matrix exercised all 35 tools advertised by `tools/list`; `missing` was empty. It covered workspace lifecycle, files, patching, grep, synchronous exec, shell lifecycle, detached task status/list/cancellation, skills, hooks, memories, Git status/diff/commit/log/checkout/branch/fetch policy, and worktree create/list/remove. The workspace was closed and the managed-container inventory returned to zero.

The live executor reported UID `10001`, could not write `/etc`, and used `networkMode=none`. `git_fetch` was intentionally rejected under the no-egress policy.

## Public request and TLS checks

- Plain HTTP redirected to HTTPS with 301.
- `/readyz` returned 200 through public TLS and loopback ingress.
- An unauthenticated MCP initialize request returned 401 with `WWW-Authenticate: Bearer realm="cloud-harness-mcp"`.
- A foreign Origin returned 403.
- A direct loopback MCP initialize and deployment canary returned 200 without exposing the bearer value.
- nginx configuration validation succeeded before reload.

## Runtime boundary evidence

Observed listeners were public nginx on ports 80/443 and Docker proxy only on `127.0.0.1:3100`. Ports 3000 and 3001 were not host listeners.

- API: non-root `node`, read-only root filesystem, no published ports, no mounts, internal frontend/control networks.
- Ingress: non-root `node`, read-only root filesystem, only `127.0.0.1:3100`, no mounts or runtime secrets, frontend/ingress networks only.
- Runner: no published ports, control/egress networks, sole Docker socket owner, root-owned secrets mounted read-only, jobs/state mounts writable as designed.
- Runtime environment file: mode `0600`, owner `root:root`.
- Managed executor/helper inventory after both production verifiers: zero.
- Journal scan for the live MCP bearer and runner token: pass (neither value present).
- systemd unit after final deployment: active and enabled.

## Failure and rollback evidence

Fail-closed behavior was observed in three real deployment failures:

- [run 31953561699](https://github.com/bestagentkits/cloud-harness-mcp/actions/runs/31953561699): Docker internal-network publication prevented loopback ingress. First-install rollback disabled/stopped the unit, removed the nginx route, and removed runtime containers.
- [run 31954650046](https://github.com/bestagentkits/cloud-harness-mcp/actions/runs/31954650046): direct-copy file modes made the non-root proxy script unreadable. Journal evidence showed `EACCES`; image-level non-root access regression coverage was added.
- [run 31955204232](https://github.com/bestagentkits/cloud-harness-mcp/actions/runs/31955204232): curl config single quotes became literal request bytes. API journal showed invalid JSON; the corrected smoke request returned MCP initialize 200.

After two successful releases, `/usr/local/sbin/cloud-harness-rollback` restored `a9693ddca779efe3fae5b501a3e3991b0b55d050`. Loopback readiness, public HTTPS 200, and systemd active/enabled state passed. The exact final release `474b6ee3c2cac36460bcc3c92d6f18243e16e876` was then redeployed; deployment canary, full production verifier, 35/35 tool matrix, and cleanup passed again. Final pointers record `474b6ee` current and `a9693dd` previous.

## Remaining private-MVP limits

- The trusted rootful runner has the Docker socket and therefore host-root-equivalent authority.
- Executors share the host kernel; this is not hostile multi-tenant isolation.
- Workspace size enforcement is best-effort on shared storage, not a hard filesystem quota.
- Executor egress is disabled by default; opt-in bridge networking is a deliberately weaker boundary.
- Rate and concurrency controls are process-local, not distributed denial-of-service protection.
- The GitHub App broker and leak boundaries are tested, but private-repository cloning was not live-run because owner App credentials were not supplied.
- Image provenance is exact-commit plus recorded local image IDs, not an externally signed registry digest.

These limits match the accepted single-owner threat model. Hostile tenancy, public anonymous access, and stronger execution isolation remain out of scope.
