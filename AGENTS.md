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
|---|---|---|
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
  socket. Executors must not receive control-plane or repository credentials.
- Preserve the executor restrictions and resource bounds owned by
  `apps/runner/src/workspace-service.ts`. Network mode remains `none` by
  default; `bridge` is an explicit owner-approved weakening, not an isolation
  guarantee.
- Preserve credential-free HTTPS repository URLs, host/address validation, and
  constrained cloning. Private-clone credentials stay in the trusted broker
  and must never persist in the checkout, remote URL, executor environment,
  logs, fixtures, or command output.
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
