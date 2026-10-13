# Cloudflare Pages landing page

The landing page is a static artifact in [`site/`](../site/). It is a separate
public surface from the private MCP service: do not bind, redirect, or proxy
`cloud-harness-mcp.46-250-239-227.sslip.io` through Pages. That hostname stays
with the VPS nginx deployment described in [VPS deployment](deployment.md).

Production URL: <https://cloud-harness-mcp.pages.dev>

## First-time setup

1. Create the direct-upload Pages project with an owner-authenticated Wrangler
   session:
   `npx wrangler pages project create cloud-harness-mcp --production-branch main`.
   Use the generated `cloud-harness-mcp.pages.dev` hostname until an owner
   explicitly approves a different custom domain.
2. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as repository
   **GitHub Actions secrets**. They are deployment credentials, not Cloudflare
   Pages runtime settings.
3. Do not add Pages secrets, environment variables, Functions, MCP bearer
   tokens, runner tokens, or GitHub App credentials. The page has no runtime
   configuration.

The authenticated account must have access to that exact project. The preflight
does not create a project, which prevents uploading the page to an unintended
account or project.

## Deploy

After the `CI` workflow succeeds on `main`,
[`deploy-pages.yml`](../.github/workflows/deploy-pages.yml) checks out that
exact tested commit and deploys `site/` to the production Pages project. Pull
requests do not run this deployment workflow or receive Cloudflare credentials.
Deployments do not overlap; GitHub may supersede an older queued deployment
when a newer successful main commit is ready. Open the matching **Deploy
Cloudflare Pages** run in GitHub Actions to inspect its preflight, upload, and
smoke-test receipt.

For an owner-authorized manual deployment, authenticate the intended Cloudflare
account and run:

```bash
npm run pages:deploy
```

The command first inventories `site/` for environment files, credential
markers, and files over the Pages upload limit. It then verifies the active
Cloudflare identity and project before uploading assets to the Pages production
branch, `main`. Do not place generated runtime artifacts beneath `site/`.

After upload, the command verifies
`https://cloud-harness-mcp.pages.dev`. This expected Pages hostname is separate
from the MCP hostname. Check the page's outbound documentation links too.

To inspect production deployment history:

```bash
npm run pages:list
```

## Rollback

Cloudflare Pages rollbacks are performed from the dashboard rather than a
Wrangler command. In **Workers & Pages** open **cloud-harness-mcp**, choose
**Deployments**, find a previous successful **production** deployment in **All
deployments**, use its actions menu, then choose **Rollback to this deployment**.
Preview deployments are not valid rollback targets. Confirm the restored
`cloud-harness-mcp.pages.dev` page after the rollback.

## Troubleshooting

- If `npm run pages:preflight` says Wrangler is unauthenticated, run
  `npx wrangler login` in the owner-controlled browser session.
- If the GitHub Actions deployment cannot list the Pages project, confirm that
  its `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` repository secrets are
  present and that the token can manage the intended account's Pages projects.
- If the named project is absent, create it in the intended account before
  deploying. Do not change the repository's project name to match a different
  account.
- If the artifact check fails, remove the named file or credential marker from
  `site/`; never suppress the check or upload a broader directory.

## Documentation site (`docs.harness.agentkit.best`)

The public documentation site is a static VitePress build in [`docs-site/`](../docs-site/) deployed to a separate Pages project: `cloud-harness-docs`.

Production URL: <https://docs.harness.agentkit.best> (Pages project: `cloud-harness-docs`).

### First-time setup

1. Create the direct-upload Pages project:
   `npx wrangler pages project create cloud-harness-docs --production-branch main`
2. In the Cloudflare Dashboard under **Workers & Pages → cloud-harness-docs → Custom Domains**, add `docs.harness.agentkit.best`.
3. CI uses the same `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` repository secrets.

### Verification and deploy commands

- **Reference generation:** `npm run docs:reference` (builds reference pages from `@cloud-harness/contracts` and `.env.example`).
- **Drift check:** `npm run docs:check` (fails if reference pages are stale).
- **Build:** `npm run docs:build` (compiles VitePress site, checks dead links, emits `.md` twins and `llms-full.txt`).
- **Artifact check:** `npm run docs:artifact` (scans `docs-site/.vitepress/dist` for forbidden files or credential leaks).
- **Deploy:** `npm run docs:deploy` (runs reference, build, preflight, deploy, and smoke test).
