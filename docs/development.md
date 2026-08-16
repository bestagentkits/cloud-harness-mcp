# Development and testing

## Prerequisites

- Node.js 24 or newer and npm
- Docker Engine with Docker Compose v2 for image and sandbox tests
- Git

Install the lockfile exactly:

```bash
npm ci
```

The root [`package.json`](../package.json) owns the maintained commands. The
normal local quality gate is:

```bash
npm run verify
```

It runs lint, type checking, non-Docker tests, and a production build. Use the
narrowest relevant command while iterating:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm test
npm run build
```

## Docker-backed verification

Build the fixed executor and service images before Docker tests:

```bash
docker compose --profile images build executor-image api runner
npm run test:docker
npm run test:e2e
```

These tests create real containers and clone a public repository, so Docker
and network access are prerequisites. They verify the MCP workflow and selected
container boundaries; the current test files, not a hand-maintained checklist,
are the test authority:

- Contract and policy tests: [`packages/contracts/test`](../packages/contracts/test/)
  and [`apps`](../apps/)
- HTTP interoperability: [`test/integration`](../test/integration/)
- Docker and complete workflow: [`test`](../test/)
- CI order and trusted-event behavior:
  [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

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
docker compose up -d api runner
docker compose ps
docker compose down
```

Do not leave watch processes or Compose stacks running after the task that
started them.

## Contribution boundary

This is a public MIT-licensed repository. Keep behavior changes in source and
tests; keep docs focused on decisions and navigation to executable owners.
Never add runtime `.env` files, tokens, private keys, deployment identities,
database contents, private repository URLs, or user data to commits or test
fixtures.
