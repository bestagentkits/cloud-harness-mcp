# Development and testing

## Prerequisites

- Node.js 24 or newer and npm
- Docker Engine with Docker Compose v2 for image and sandbox tests
- Git

Install the lockfile exactly:

```bash
npm ci
```

The root [`package.json`](../package.json) is the authority for maintained
commands and their ordering. Use its `verify` script as the normal local
quality gate and choose the narrowest owned script while iterating; do not
duplicate the script graph in documentation.

## Docker-backed verification

Docker and network access are prerequisites for the Docker suites. Build the
fixed images named by the current Compose files, then use the root
`verify:compose`, `test:docker`, and `test:e2e` scripts as applicable. Their
executable authorities are:

- Static service, mount, environment, and network invariants:
  [`scripts/verify-compose-boundaries.mjs`](../scripts/verify-compose-boundaries.mjs)
- Contract and policy behavior:
  [`packages/contracts/test`](../packages/contracts/test/) and
  [`apps`](../apps/)
- HTTP and real-container isolation:
  [`test/integration`](../test/integration/)
- Complete MCP-to-Pi workflow:
  [`test/e2e/coding-workflow.docker.test.ts`](../test/e2e/coding-workflow.docker.test.ts)
- CI ordering and trusted-event policy:
  [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

The coding-agent E2E uses the `gateway-test` Compose profile, generated local
TLS fixtures, actual Pi, and a fake provider that is unavailable in production
mode. It proves the repository's bounded path without spending provider
credits; it does not verify a live provider, private repository, or
repository-defined deployment. Fixture generation and profile selection are
owned by the root package scripts,
[`scripts/generate-model-gateway-test-fixtures.mjs`](../scripts/generate-model-gateway-test-fixtures.mjs),
and [`compose.yaml`](../compose.yaml).

After a failed Docker test, inspect managed leftovers without deleting
unrelated containers:

```bash
docker ps -a --filter label=cloud-harness.managed=true \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Label "cloud-harness.workspace"}}'
```

Remove only an explicitly verified test container. Never use a broad container
cleanup command on a shared Docker host.

## Local service development

Copy [`.env.example`](../.env.example) to `.env` and replace its placeholder
secrets. The API and runner can be watched separately with `npm run dev:api`
and `npm run dev:runner`, but the runner still needs its persistence paths,
Docker access, and matching service token. Compose is the more representative
topology:

```bash
docker compose --profile images build
docker compose up -d runner api ingress
docker compose ps
docker compose down
```

Coding-agent service development additionally requires the agent and
model-gateway images plus a runner profile that matches a gateway profile.
Use production-mode gateway configuration only with an operator-supplied
credential; use the fake provider only through the owned E2E profile.

Do not leave watch processes or Compose stacks running after the task that
started them.

## Contribution boundary

This is a public MIT-licensed repository. Keep behavior changes in source and
tests; keep docs focused on decisions and navigation to executable owners.
Never add runtime `.env` files, tokens, private keys, deployment identities,
database contents, private repository URLs, or user data to commits or test
fixtures.

## Automated releases

Conventional Commit messages determine release versions: `fix` and `perf`
produce patches, `feat` produces a minor version, and a `BREAKING CHANGE`
footer or `!` produces a major version. A successful push CI run on `dev`
creates a `-beta.N` GitHub release; a successful push CI run on `main` creates
the stable release. Pull-request runs never release.

The release workflow commits the generated [`CHANGELOG.md`](../CHANGELOG.md)
and synchronized workspace/runtime versions, then tags that metadata-only
release commit. CI proves the preceding source commit; the tag is derived from
that exact tested source plus the generated metadata. Before enabling the first
automated release, create and protect `dev`, and either seed the intended
`v0.2.0` baseline tag or accept `1.0.0` as the first generated version. Branch
rules must allow the repository's `GITHUB_TOKEN` to write these generated
release commits.
