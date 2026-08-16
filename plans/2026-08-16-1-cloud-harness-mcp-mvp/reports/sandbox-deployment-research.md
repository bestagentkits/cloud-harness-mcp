---
title: "Cloud Harness MCP sandbox and deployment research"
date: 2026-08-16T19:27:00+07:00
status: complete
scope: "Ubuntu VPS 46.250.239.227; Docker Engine 28.3.3"
---

# Cloud Harness MCP sandbox and deployment research

## Summary

Recommended MVP: one authenticated owner, one allowlisted repository at a time, Caddy TLS in front of an MCP process bound to loopback, and a fresh constrained Docker container plus isolated clone for every job. Executor containers get no credentials, Docker socket, host network, devices, or host paths beyond their own job directory. Default egress is none. A server-side watchdog enforces wall-clock TTL and cleanup.

This is a **private single-user MVP**, not a hostile multi-tenant service. Docker containers share the host kernel. In addition, membership in the `docker` group is effectively root-level host access; therefore the observed `dev` account and any process able to reach its Docker socket belong to the trusted control plane. Before accepting arbitrary tenants, separate the control plane from execution hosts and use a VM/microVM or equivalent stronger kernel boundary per tenant/job.

## Contents

- [Threat model and boundaries](#threat-model-and-boundaries)
- [MVP architecture](#mvp-architecture)
- [Sandbox contract](#sandbox-contract)
- [Filesystem and repository model](#filesystem-and-repository-model)
- [Egress](#egress)
- [Credentials](#credentials)
- [HTTPS and MCP edge](#https-and-mcp-edge)
- [GitHub Actions deployment](#github-actions-deployment)
- [Hardening checklist](#hardening-checklist)
- [Verification](#verification)
- [Multi-tenant production delta](#multi-tenant-production-delta)
- [Official references](#official-references)
- [Unresolved questions](#unresolved-questions)

## Threat model and boundaries

### Assets

- VPS host, Docker daemon, deployment account, MCP authorization secret.
- Checked-out source and any private repository credentials.
- Availability: CPU, RAM, PIDs, disk, network, and container slots.
- Other jobs' source, patches, logs, and session state.

### Adversarial inputs

- Repository files, build scripts, package lifecycle scripts, tests, symlinks, oversized output, fork bombs, and network clients.
- MCP tool arguments, repository URLs, branch/ref names, job IDs, and JSON bodies.
- Compromised dependencies, container images, GitHub Actions, or a deployment key.
- Internet requests, forged `Host`/`Origin`, replayed bearer tokens, and slow/oversized streams.

### Trust boundaries

```text
MCP client
  -> Internet / TLS
  -> Caddy (only public 80/443)
  -> MCP control plane on 127.0.0.1
  -> Docker API (host-admin boundary)
  -> per-job executor container (repo code is untrusted)
  -> per-job workspace only
```

The MCP process, its service account, deployment path, and Docker socket are trusted. Repository code is not. The executor must never inherit control-plane credentials or Docker access. A container escape remains a host-kernel risk; plain Docker is defense in depth, not an adequate hostile-tenant boundary.

### Explicitly out of scope for MVP

- Anonymous/public access, arbitrary tenants, billing, and strong tenant isolation.
- Running user-provided Dockerfiles, privileged containers, Docker-in-Docker, nested virtualization.
- General unrestricted Internet access or arbitrary `file:`, `ssh:`, local-path, or private-network clone URLs.
- Security claims against kernel/runtime zero-days.

## MVP architecture

1. Caddy listens on `80/443`; MCP listens only on `127.0.0.1:<port>`.
2. Application validates bearer authorization, `Origin`, request size, tool schema, and per-user concurrency before creating a job.
3. Controller creates a UUID job directory beneath a fixed parent, materializes an isolated repository clone, and records owner, container ID, creation time, and expiry.
4. Controller starts only an administrator-owned, digest-pinned executor image with fixed security flags. It launches Docker via an argument array/SDK, never by interpolating tool input into a shell command.
5. A watchdog kills the process/container at deadline. A separate systemd timer reaps stale labeled containers and directories after crashes/reboots.
6. Controller collects bounded stdout/stderr and the patch/result, then removes the container and workspace.

Do not expose the Docker daemon over TCP or mount `/var/run/docker.sock` into any container. The [Docker Linux post-install documentation](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user) warns that the `docker` group grants root-level privileges.

### Docker daemon choice on this VPS

- **Immediate private MVP:** existing rootful Docker 28.3.3 is usable only if the MCP endpoint is private/authenticated and repos are owner-approved. Retain the default seccomp and `docker-default` AppArmor profiles; never use `unconfined`.
- **Preferred before arbitrary repo URLs:** run a dedicated rootless Docker daemon under a `harness` account that is not in the system `docker` group. Rootless mode places daemon and containers in a user namespace. Verify cgroup v2/systemd before relying on CPU, memory, and PID flags. Docker 28 rootless has feature limitations, including AppArmor, so this is a trade-off: lower daemon privilege versus losing the current AppArmor layer. Record and test the chosen mode; do not silently assume both.
- **Alternative when AppArmor is required:** retain rootful Docker, enable user-namespace remapping, and put Docker operations behind a narrow local broker that fixes image, mounts, flags, labels, and limits. Merely changing from `dev` to another docker-group user does not reduce Docker-socket authority.

Upgrade Engine and Ubuntu security packages before Internet exposure, then continuously apply supported security updates. Do not change isolation behavior during an unattended major Docker upgrade without regression tests.

## Sandbox contract

Use one container per job. Suggested starting defaults (configuration, not user-controlled flags):

| Control | MVP default | Enforcement |
|---|---:|---|
| Wall-clock TTL | 15 min | Application timer plus independent reaper |
| Idle TTL | 5 min | Last tool/output activity |
| Concurrent jobs | 1 (raise only after load test) | Queue/semaphore |
| CPU | 1.0 CPU | `--cpus=1.0` |
| Memory/swap | 1 GiB / 1 GiB total | `--memory=1g --memory-swap=1g` |
| PIDs | 256 | `--pids-limit=256` |
| Open files | 1,024 | `--ulimit nofile=1024:1024` |
| Captured output | 10 MiB/job | Stream counter; truncate and mark result |
| Workspace | 2 GiB soft cap for MVP | Watcher plus host free-space floor; hard quota required for hostile use |

Representative executor flags:

```text
docker run --detach --init
  --name ch-<server-generated-uuid>
  --label cloud-harness.job=<uuid>
  --label cloud-harness.expires-at=<unix-seconds>
  --network none
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m
  --tmpfs /run:rw,noexec,nosuid,nodev,size=16m
  --mount type=bind,src=/srv/cloud-harness/jobs/<uuid>/workspace,dst=/workspace
  --workdir /workspace
  --user 10001:10001
  --cap-drop ALL
  --security-opt no-new-privileges=true
  --pids-limit 256
  --memory 1g --memory-swap 1g
  --cpus 1.0
  --ulimit nofile=1024:1024
  --stop-timeout 10
  --pull never
  ghcr.io/<owner>/cloud-harness-executor@sha256:<digest>
```

Keep Docker's default seccomp profile and default AppArmor profile rather than disabling either. Add no capabilities unless a measured workload requires one. Never allow `--privileged`, `--device`, `--pid=host`, `--ipc=host`, `--network=host`, writable system bind mounts, `/proc`/`/sys` overrides, or the Docker socket. Pin an administrator-built image by digest and make image selection server-side.

`--read-only` does not protect the writable workspace. A 2 GiB `du` watcher is only acceptable for the single-user MVP because it can lose a race against rapid disk fill. Hostile use requires an actual filesystem quota (for example an XFS project quota/storage quota on a dedicated jobs filesystem) plus a reserved host free-space floor.

## Filesystem and repository model

Use a fixed root such as `/srv/cloud-harness/jobs`; it must not contain app config, deployment keys, the controller checkout, or other users' work. Generate IDs server-side as UUIDs and reject all caller-supplied path fragments. Resolve paths and assert they remain directly beneath the job root before create, mount, archive, or delete.

For MVP, prefer an independent clone per job:

```text
/srv/cloud-harness/jobs/<uuid>/
  metadata.json       # controller-owned, not mounted
  workspace/          # only writable host bind mount
  result/             # controller-owned exported patch/manifest
```

- Clone on the trusted side, then remove embedded URL credentials before execution. For local source, use `git clone --no-local` so the job does not share hardlinks or writable Git metadata with the controller repository.
- Chown only the job workspace to the fixed container UID/GID. Parent and metadata stay controller-owned.
- Never mount `/home`, `/root`, `/etc`, `/var/run`, the controller checkout, SSH agent sockets, or the shared bare repository.
- On completion, derive a bounded patch/file manifest, remove the container first, then delete the exact resolved job directory. Do not follow symlinks during collection or cleanup.

Git worktrees are faster but their `.git` file points into shared repository metadata. Making that metadata writable inside an untrusted container lets one job affect other refs/worktrees; mounting it read-only breaks normal Git writes. Therefore do **not** use shared worktrees for the executor in MVP. If later optimized, create the worktree on the trusted side, expose only a filesystem snapshot to the executor, and generate the patch outside the container.

## Egress

Default executor network is `--network none`. This prevents source exfiltration, SSRF to the VPS/cloud metadata/private LAN, scanning, callbacks, cryptomining pools, and surprise dependency downloads.

If dependency fetching becomes necessary, make it a separate explicit profile:

1. Put executors on an `--internal` Docker network with no direct route.
2. Put an authenticated HTTP(S) egress proxy on both the internal network and an outbound network.
3. Permit only the proxy address/port; allowlist required registries by hostname; log domain, bytes, job, and decision.
4. Keep secrets out of the executor even with allowlisted egress. A dependency script can still send anything available to any allowed endpoint.
5. Block link-local, loopback, RFC1918/ULA, VPS host/gateway, Docker daemon, and cloud metadata destinations. Rate- and byte-limit downloads.

Docker-published ports can bypass the UFW path because Docker diverts traffic in `nat`. Publish no executor ports. Bind the MCP app directly to host loopback, and inspect Docker's `DOCKER-USER`/forwarding rules rather than assuming UFW covers containers. Do not set Docker's `iptables=false`; Docker documents that this can break isolation.

## Credentials

- Store the MCP bearer secret outside Git and images in a root-owned file or systemd credential; grant only the MCP service read access. Rotate after suspected disclosure. Never include tokens in URLs or access logs.
- The executor receives no MCP token, GitHub token, SSH private key, `SSH_AUTH_SOCK`, `.netrc`, `.git-credentials`, cloud credential, host environment dump, or deployment secret.
- Start with public/allowlisted repositories. For private repositories, the trusted clone service should mint a short-lived, repository-scoped GitHub App installation token, use it only for clone, remove it from remote configuration/logs, and never forward it into execution.
- Redact request authorization and likely secret fields at structured-logger boundaries. Bound logs and artifact retention; single-user does not mean logs are safe for secrets.
- Separate deployment identity from runtime identity. The deploy user must not be the public MCP service user and should have only the narrow sudo command needed for atomic deployment/restart.

## HTTPS and MCP edge

Best public option: point a domain at `46.250.239.227`, install Caddy from its official Ubuntu package, open `80/443`, and proxy to loopback:

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy automatically provisions/renews certificates and redirects HTTP to HTTPS when DNS and ports are correct. Do not publish `3000`. If there is no domain, prefer an SSH/VPN tunnel to a loopback-only MCP server rather than exposing plaintext HTTP to the IP.

Application-layer requirements:

- Match `Host` and allow only the configured `Origin`; reject any present but unrecognized Origin before session creation. The MCP Streamable HTTP specification requires Origin validation against DNS rebinding and recommends authentication.
- Require authorization on every MCP request, including GET/SSE resume. Use constant-time secret comparison. Return `401`/`403` without credential detail.
- For the private MVP, a long random pre-shared bearer token is a temporary interoperability choice. Hostile/multi-user deployment should implement the current MCP HTTP authorization profile (OAuth 2.1 protected-resource metadata, HTTPS, PKCE where applicable, audience validation, and short-lived scoped tokens).
- Enforce JSON/content type, maximum request body, schema depth/size, session ownership, request deadline, stream count, and rate limits in the app. Caddy TLS does not provide tool authorization.
- Preserve streaming behavior and test client disconnect cancellation so orphaned jobs do not survive closed MCP sessions.

## GitHub Actions deployment

Use two jobs: unprivileged CI, then a `production` environment deployment only from protected `main` or a signed/version tag. Recommended workflow properties:

```yaml
permissions:
  contents: read
concurrency:
  group: cloud-harness-production
  cancel-in-progress: false

jobs:
  deploy:
    if: github.ref == 'refs/heads/main'
    environment: production
    runs-on: ubuntu-latest
```

- Run lint/tests/build before any deployment secret is available. Never run the deploy job for pull requests or `pull_request_target` code.
- Pin every third-party action to a reviewed full commit SHA. `actions/checkout` should also be pinned. Grant per-job `GITHUB_TOKEN` permissions only when needed.
- Store `VPS_SSH_PRIVATE_KEY` and pinned `VPS_HOST_KEY` as **production environment secrets**. Keep host/user/domain as non-secret environment variables. GitHub environments can restrict branches and gate access to secrets.
- Use a dedicated non-root `deploy` account and key. Its sudoers entry permits only an immutable, root-owned deployment script, not arbitrary `sudo`, shell, Docker, or file writes. The script validates release/image digest, updates an atomic release or digest-pinned service, runs health checks, and rolls back on failure.
- Create `$RUNNER_TEMP/deploy_key` and `$RUNNER_TEMP/known_hosts` with mode `0600`; feed secret content from environment or stdin with shell tracing disabled. Never place a secret directly in command arguments, print it, print the environment, upload it as an artifact/cache, or use live `ssh-keyscan` as trust-on-first-use.
- Prefer deploying a tested immutable image/artifact by digest. If GHCR is private, use a read-only pull credential on the VPS; the Actions job can use its short-lived `GITHUB_TOKEN` only with the minimal `packages: write` permission in the image-publish job.
- GitHub log masking is an accidental-disclosure aid, not a security boundary. Register generated sensitive values with `::add-mask::` before any possible output, but design commands so values are never printed.

Minimal deployment sequence:

```text
CI: checkout pinned SHA -> test -> build -> publish artifact/image -> record digest
Deploy: environment gate -> install ephemeral SSH material -> invoke fixed deploy script with digest
VPS: pull/stage -> migrate if explicitly required -> restart -> loopback health check -> rollback on failure
Finally: shred/remove runner temp key material (hosted runner is also ephemeral)
```

## Hardening checklist

### Host and control plane

- [ ] Patch Ubuntu/Docker; confirm daily security updates and reboot policy.
- [ ] SSH keys only; disable password/root login after confirming a second working admin session.
- [ ] UFW default deny inbound; allow SSH from an admin CIDR where possible and public `80/443` only.
- [ ] MCP service runs as a dedicated account with `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, a narrow `ReadWritePaths=`, and no interactive login.
- [ ] Choose and document rootful+AppArmor versus rootless; remove public service accounts from the system `docker` group when using rootless.
- [ ] Docker daemon socket remains a local trusted-control-plane endpoint; no TCP listener.
- [ ] Caddy and MCP app are separate services; backend listens only on loopback.

### Job admission and lifecycle

- [ ] Only server-generated UUID job IDs; canonical parent checks on all paths.
- [ ] Allowlisted `https` repository host/ref for MVP; reject userinfo, local/file/SSH URLs and private-IP redirects.
- [ ] Fixed digest-pinned image and fixed run flags; no caller-provided mount/image/security options.
- [ ] Auth, Origin, rate, body, concurrency, output, and time limits enforced before/while running.
- [ ] Independent reaper handles restart/crash; startup reconciliation removes expired labeled containers.
- [ ] Cleanup order: stop/remove container, collect bounded result, remove exact job directory, retain only minimal audit metadata.

### Executor

- [ ] Non-root UID, all capabilities dropped, no-new-privileges, default seccomp, applicable AppArmor.
- [ ] Read-only root filesystem; small `noexec,nosuid,nodev` tmpfs mounts.
- [ ] No network by default; no published ports, devices, host namespaces, or Docker socket.
- [ ] CPU, memory+swap, PIDs, file descriptors, output, TTL, concurrency, and disk controls tested.
- [ ] No control-plane/deployment/repository credential in environment, filesystem, process args, or logs.

## Verification

Run against a disposable test job/image; avoid printing secret values.

### Host baseline

```bash
docker version
docker info --format '{{json .SecurityOptions}}'
docker context show
aa-status
stat -c '%A %U %G %n' /var/run/docker.sock
ss -ltnp
sudo ufw status verbose
sudo iptables -S DOCKER-USER
systemctl is-enabled unattended-upgrades
systemctl status caddy cloud-harness --no-pager
```

Expected: seccomp plus the selected rootful/AppArmor or rootless mode; Docker socket not public; only SSH and Caddy public; MCP port loopback-only.

### Container contract

```bash
docker inspect ch-<uuid> --format '{{json .HostConfig}}'
docker exec ch-<uuid> id
docker exec ch-<uuid> sh -c 'touch /etc/should-fail'
docker exec ch-<uuid> sh -c 'touch /workspace/should-succeed'
docker exec ch-<uuid> sh -c 'test ! -S /var/run/docker.sock'
docker exec ch-<uuid> sh -c 'test ! -r /run/secrets/mcp-token'
docker exec ch-<uuid> sh -c 'ip route; wget -T 2 -qO- https://example.com'
```

Expected: non-root identity; `/etc` write and egress fail; workspace write succeeds; no Docker socket/secret. Inspect must show `ReadonlyRootfs=true`, `NetworkMode=none`, limits, dropped capabilities, and no host namespace sharing.

Automated integration tests should also prove:

- Memory and PID exhaustion terminate/fail inside the job without degrading the host.
- TTL removes both a sleeping container and its workspace; restart reconciliation removes an expired orphan.
- `../`, absolute paths, symlink escapes, malicious ref/repository URL, oversized JSON/output, and duplicate job IDs are rejected.
- One job cannot read another job directory or metadata.
- Missing/bad bearer token returns `401`; foreign Origin/Host returns `403`; valid MCP initialize and Streamable HTTP/SSE work over HTTPS.
- Disconnect/cancel stops work; concurrent-job and rate limits return a bounded error.
- Deployment health-check failure leaves or restores the previous release.

### HTTPS/deployment

```bash
caddy validate --config /etc/caddy/Caddyfile
curl -fsS -o /dev/null -w '%{http_code}\n' https://mcp.example.com/healthz
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' https://mcp.example.com/mcp
gh run list --workflow deploy.yml --limit 5
```

Do not put a real token in shell history. Run authorized checks through the MCP client or read it from a protected file into a process without echoing it. Review Actions logs for accidental environment dumps, command tracing, key material, and overly broad permissions.

## Multi-tenant production delta

Do not market the MVP sandbox as hostile multi-tenant isolation. Before that transition:

| Area | Private single-user MVP | Hostile multi-tenant production |
|---|---|---|
| Compute boundary | Hardened Docker container | Dedicated VM/microVM or separately evaluated sandbox runtime; separate execution hosts |
| Kernel | Shared with trusted owner jobs | Never shared solely on Docker trust; patched disposable workers |
| Control plane | Same VPS acceptable | Separate network/account from workers; no Docker socket in web process |
| Identity | One rotated bearer token | MCP OAuth 2.1, short-lived scoped/audience-bound tokens, per-tenant authorization |
| Storage | Isolated clone + soft watcher cap | Per-tenant encryption/namespace and hard project/volume quota; verified destruction |
| Network | None or explicit proxy | Per-tenant policy, forced proxy, destination/byte/rate controls, metadata/LAN denial |
| Scheduling | One global queue | Per-tenant quotas, fairness, admission control, abuse response |
| Supply chain | Admin image pinned by digest | Signed/verified images, SBOM/scanning, provenance policy, controlled builders |
| Operations | Minimal bounded logs | Tenant-aware audit, anomaly detection, incident response, backups/retention policy |

Production also needs an external security review and destructive escape/DoS testing on disposable infrastructure. Docker hardening flags remain useful inside the stronger boundary, but do not replace it.

## Official references

- Docker: [Engine security](https://docs.docker.com/engine/security/), [rootless mode](https://docs.docker.com/engine/security/rootless/), [rootless limitations/resource notes](https://docs.docker.com/engine/security/rootless/tips/), [default seccomp](https://docs.docker.com/engine/security/seccomp/), [AppArmor](https://docs.docker.com/engine/security/apparmor/), [`docker run`](https://docs.docker.com/reference/cli/docker/container/run/), [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/), [bind-mount risk](https://docs.docker.com/engine/storage/bind-mounts/), [firewall/UFW interaction](https://docs.docker.com/engine/network/packet-filtering-firewalls/), [Docker group warning](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user).
- MCP: [Streamable HTTP transport and Origin requirements, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [HTTP authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
- GitHub: [secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use), [secrets in workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments), [compromised runner impact](https://docs.github.com/en/actions/concepts/security/compromised-runners).
- Caddy: [official Ubuntu installation](https://caddyserver.com/docs/install), [automatic HTTPS](https://caddyserver.com/docs/automatic-https), [`reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
- Ubuntu: [security suggestions](https://ubuntu.com/server/docs/explanation/security/security_suggestions/), [firewall](https://documentation.ubuntu.com/server/how-to/security/firewalls/), [automatic updates](https://ubuntu.com/server/docs/how-to/software/automatic-updates/).

## Unresolved questions

1. Which Ubuntu release, filesystem/storage driver, cgroup version, RAM, CPU, and free disk does the VPS have? These determine safe numeric limits and whether hard workspace quotas/rootless cgroups work.
2. Is a DNS name available, or must access remain behind SSH/VPN?
3. Are repositories public and owner-allowlisted, or must private/arbitrary GitHub repositories work in MVP?
4. Must executor jobs access package registries? If yes, which exact registries/domains and maximum download volume?
5. Which MCP clients must interoperate, and do they support the current OAuth authorization profile or only a configured bearer header?
