# Cloudflare Pages landing page

The landing page is a static artifact in [`site/`](../site/). It is a separate
public surface from the private MCP service: do not bind, redirect, or proxy
`cloud-harness-mcp.46-250-239-227.sslip.io` through Pages. That hostname stays
with the VPS nginx deployment described in [VPS deployment](deployment.md).

Production URL: <https://cloud-harness-mcp.pages.dev>

## First-time setup

1. Authenticate the intended Cloudflare account with `npx wrangler login`.
2. Create the direct-upload Pages project with
   `npx wrangler pages project create cloud-harness-mcp --production-branch main`.
   Use the generated `cloud-harness-mcp.pages.dev` hostname until an owner
   explicitly approves a different custom domain.
3. Do not add Pages secrets, environment variables, Functions, API tokens,
   MCP bearer tokens, runner tokens, or GitHub App credentials. The page has no
   runtime configuration.

The authenticated account must have access to that exact project. The preflight
does not create a project, which prevents uploading the page to an unintended
account or project.

## Deploy

Install the repository dependencies, then run:

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
- If the named project is absent, create it in the intended account before
  deploying. Do not change the repository's project name to match a different
  account.
- If the artifact check fails, remove the named file or credential marker from
  `site/`; never suppress the check or upload a broader directory.
