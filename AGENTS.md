# Cloud Harness MCP collaborator guide

## Purpose and authority

Cloud Harness MCP is intentionally a private, single-owner remote coding
harness. Preserve that threat model: it permits arbitrary repository-controlled
execution inside a constrained executor, but it is not a hostile multi-tenant
sandbox.

Start with [`README.md`](README.md). Read the relevant document under `docs/`
before changing its boundary. Code, schemas, tests, manifests, and scripts own
WHAT and HOW; documentation owns WHY and WHERE. Point docs to executable owners
instead of copying behavior, defaults, command inventories, or configuration.

## Navigation

| Concern | Read first | Executable authority and evidence |
| --- | --- | --- |
| Trust model and isolation | [`docs/security-model.md`](docs/security-model.md) | `apps/api/src/request-security.ts`, `apps/runner/src/workspace-service.ts`, `test/integration/docker-sandbox.docker.test.ts` |
| Public MCP contract | [`docs/mcp-api.md`](docs/mcp-api.md) | `packages/contracts/src/`, `apps/api/src/mcp-server.ts`, `packages/contracts/test/`, `test/integration/` |
| API/runner boundary | [`docs/system-architecture.md`](docs/system-architecture.md) | `apps/api/src/`, `apps/runner/src/`, `compose*.yaml`, `scripts/verify-compose-boundaries.mjs` |
| Repository and executor behavior | [`docs/security-model.md`](docs/security-model.md) | `apps/runner/src/repository-policy.ts`, `worker/`, runner and Docker tests |
| Configuration | [`docs/configuration.md`](docs/configuration.md) | `.env.example`, `packages/contracts/src/config.ts`, `apps/api/src/config.ts`, `apps/runner/src/config.ts`, `compose*.yaml` |
| Development and verification | [`docs/development.md`](docs/development.md) | `package.json`, `.github/workflows/ci.yml`, tests |
| Deployment and recovery | [`docs/deployment.md`](docs/deployment.md), [`docs/operations.md`](docs/operations.md), [`docs/troubleshooting.md`](docs/troubleshooting.md) | `deploy/`, `compose.production.yaml`, `scripts/verify-production.mjs`, `scripts/deploy-canary.mjs` |
| Operator dashboard UI | [`docs/design-guidelines.md`](docs/design-guidelines.md) | `apps/api/dashboard/`, `apps/api/src/dashboard-router.ts`, `apps/api/src/dashboard-assets.ts`, `apps/api/test/dashboard-ui-contract.test.ts` |
| Official user docs & guides | `docs-site/` | `docs-site/`, `scripts/build-docs-reference.mjs`, `npm run docs:build` |
| Agent skill & MCP tool guidance | [`.agents/skills/cloudharness/SKILL.md`](.agents/skills/cloudharness/SKILL.md) | `.agents/skills/cloudharness/`, `plugins/cloud-harness/`, `packages/contracts/test/cloudharness-skill-contract.test.ts`, `npm run plugin:sync` |

## Safety-critical invariants

- Keep the credential-free ingress proxy as the only host-published Compose
  service, bound to loopback. The API and runner must not publish host ports;
  the ingress must not receive secrets or join the control network.
- Keep Docker authority, job/state mounts, and optional GitHub App credentials
  confined to the runner. The API must not receive host mounts or the Docker
  socket. Executors must not receive control-plane credentials, and the harness
  must not push repository credentials into them. The single documented
  exception is an operator-created GitHub runtime secret (`GH_TOKEN` or
  `GITHUB_TOKEN`), which is an explicit owner opt-in for authenticating the
  workspace `gh` CLI and is recorded in `docs/security-model.md`.
- Preserve the executor restrictions and resource bounds owned by
  `apps/runner/src/workspace-service.ts`. `dependency-access` is the
  owner-approved shipped network default and `network-none` remains the isolation
  opt-out, per workspace or instance-wide; the executable owners and
  `docs/security-model.md` own the resolution order, the per-start attestation
  requirement, and the fail-closed `DEPENDENCY_EGRESS_UNAVAILABLE` behaviour. No
  raw `bridge` profile is selectable, and egress is never a silent downgrade.
- Preserve credential-free HTTPS repository URLs, host/address validation, and
  constrained cloning. Private-clone credentials stay in the trusted broker
  and must never persist in the checkout, remote URL, logs, fixtures, or command
  output; the executor-environment exception is the operator-injected GitHub
  runtime secret named above.
- Treat the schemas and result envelope in `packages/contracts/src/` and the
  lifecycle, idempotency, restart, and truncation semantics in
  `docs/mcp-api.md` as public contracts. Change their source, tests, and user
  guidance together.
- Scope cleanup by the verified workspace identity, canonical job path, state
  record, and managed-container labels. Never recursively remove a jobs root or
  run broad Docker cleanup on a shared host.
- Never commit `.env` files, tokens, keys, databases, runtime state, private
  repository URLs, or user data. Do not claim live private-clone or production
  verification without owner-authorized, sanitized evidence.
- Treat bootstrap, deployment, rollback, production verification, and manual
  container or state recovery as live operations. Follow the owning runbook,
  resolve exact targets first, and do not perform them from an ordinary code
  task without explicit authorization.

## Deploy failure lessons

- A `Deploy production` failure at `deploy-canary.mjs` with
  `UND_ERR_CONNECT_TIMEOUT`/`ECONNREFUSED` right after `compose up` is usually
  a transient route gap in the freshly recreated container, not a release bug.
  Confirm from the host (`docker exec cloud-harness-mcp-ingress-1 node -e ...`
  TCP probe to the canary host) before changing code; the canary retries only
  its first side-effect-free `server/discover` call on transport errors. Never
  read or print the canary credentials file while diagnosing.
- The `curl ... port 3100` lines before the canary are the expected readiness
  wait loop, not the failure.
- `client_loop: send disconnect: Broken pipe` mid-build means the CI session
  dropped. Check the host with `systemctl status cloud-harness-deploy-<sha>`
  and its journal, not the CI log: the deploy runs as that systemd unit and
  keeps going. Never move the deploy back into the SSH/sudo session; sudo kills
  the process group before any rollback trap can run.
- The installed `/usr/local/sbin/cloud-harness-deploy` is the previous
  release's script, so a fix to `deploy-release.sh` protects only later
  deploys. Deploying an older commit never downgrades it
  (`/var/lib/cloud-harness/deploy-tooling-release`).
- A leftover `/var/lib/cloud-harness/deploy-in-progress` means a deploy was
  killed after stopping the release; `cloud-harness-deploy-recover.service`
  (boot) or the deploy unit's `ExecStopPost` rolls it back. Do not delete the
  marker by hand before reading its journal.

## Issue and PR coordination

Parallel contributors and agents coordinate through issue state, so keep it
current:

- Before starting an issue, check its labels, assignees, and linked PRs. Skip or
  coordinate on an issue already `in progress`, `in review`, or `done`.
- Assign yourself (or the requesting owner) and move the issue through exactly
  one status label at a time: `in progress` while implementing, `blocked` when
  waiting on an external decision or prerequisite (comment what blocks it),
  `in review` during isolated code review, `done` once the PR is open and green,
  and `shipped` after it merges to `main`.
- `main` is the integration branch; merging to it triggers `Deploy production`,
  so a merge is a live operation that needs owner authorization.
- When you find a related or duplicate issue, comment on it with a reference to
  the issue you are working on instead of duplicating work. File an unrelated
  defect you discover as its own issue rather than widening the current PR.

## Change workflow

1. Inspect the relevant document, executable owner, nearby tests, and current
   working tree. Preserve unrelated edits.
2. For defects, prove the failure and its boundary before changing behavior.
   Keep changes narrow and preserve public contracts unless the accepted scope
   intentionally changes them.
3. Run the narrowest relevant test first, then the applicable repository gate:
   - Normal code changes: `npm run verify`. On Windows or non-POSIX hosts, use
     targeted suites (`npm run test:unit`, `npm run test:integration`, `npm run lint`,
     `npm run typecheck`) as your baseline; shell fixture tests in
     `test/deploy-release-runtime.test.ts` and `test/upgrade-nginx-routes.test.ts`
     require a POSIX host and are verified in Linux CI.
   - Compose or network-boundary changes: `npm run verify:compose` and
     `npm run verify`.
   - Shell changes: run the syntax check owned by `.github/workflows/ci.yml`.
   - Docker/executor changes: build with
     `docker compose --profile images build executor-image api runner`, then run
     `npm run test:docker` and `npm run test:e2e` when Docker and network access
     are available.
4. Do not weaken security checks, cleanup assertions, timeouts, or tests to make
   a gate pass. Report an unavailable prerequisite or pre-existing failure.
5. If you start watch processes or Compose services, check for an existing
   project process first, track what you start, and stop it when the task ends.

Use `npm ci` for a clean dependency install. The root `package.json` remains the
command authority; do not duplicate its full script list here. Do not run
`npm run verify:production` casually: it targets a live MCP endpoint, requires
owner credentials, and creates a disposable workspace.

Whenever shipping changes with user or operational impact (new features,
workflows, configuration keys, public contracts, troubleshooting steps, or use
cases), evaluate and update both internal docs (`docs/`) and the official docs
site (`docs-site/`). Keep user and operator guides in sync (such as
`docs-site/ai-tools/`, `docs-site/dashboard/`, `docs-site/reference/`, and
`docs-site/troubleshooting.md`), and run `npm run docs:reference` or
`npm run plugin:sync` if tool or contract surfaces changed.

Whenever MCP tool surfaces, schemas, capabilities, options, execution behaviors,
or workspace lifecycle features change or are added:

- Update `.agents/skills/cloudharness/SKILL.md` and the affected reference
  documents under `.agents/skills/cloudharness/references/` to keep agent tool
  usage guidance accurate and effective.
- Run `npm run plugin:sync` to ensure `.agents/skills/cloudharness/` and
  `plugins/cloud-harness/skills/cloudharness/` remain byte-identical.
- Verify skill contract compliance by running
  `npm test packages/contracts/test/cloudharness-skill-contract.test.ts` (or
  `npm run verify`).

Keep plans and reports out of evergreen guidance, and do not add release notes
or governance files unless the repository contract requires them.
