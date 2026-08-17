---
title: "Phase 3: Verify and publish Cloudflare Pages"
status: todo
---

# Phase 3: Verify and publish Cloudflare Pages

## Overview

Validate the artifact, document its independent Cloudflare Pages deployment, then publish it.

## Requirements

- [x] Verify HTML/CSS behavior, artifact inventory, outbound links, and the repository quality gate appropriate to static-file changes.
- [x] Pin Wrangler and document the Pages project name, generated/custom hostname decision, deploy command, environment-variable policy, deployment-list command, and Cloudflare dashboard rollback procedure without recording credentials.
- [x] Deploy using the authenticated Cloudflare account and smoke-test the returned URL.
- [x] Confirm that `site/` contains no environment files, credentials, generated runtime state, bearer tokens, runner tokens, or GitHub App material before upload.

## Implementation Steps

1. Add pinned `wrangler` scripts for account/project preflight, deployment listing, and production upload. Document the Cloudflare dashboard rollback flow, because Pages rollbacks are a dashboard/API action rather than a Wrangler command.
2. Run static checks, artifact/secret inventory, deployed-link validation, and inspect the landing page at desktop and mobile viewport widths.
3. Add `docs/cloudflare-pages.md`, update README navigation, and keep the VPS deployment guide unchanged.
4. Run the account/project preflight, deploy `site/` to `cloud-harness-mcp`, and verify the returned Pages hostname is not the MCP hostname.
5. List deployments to demonstrate the rollback target can be selected, then smoke-test the production URL.
6. If Cloudflare authentication or project permission is unavailable, record the exact prerequisite as an external blocker; leave the plan incomplete and do not substitute another provider.

## Todo

- [x] Validate the artifact, accessibility, links, and repo integration.
- [x] Publish or identify the exact authentication/project-permission blocker.

## Success Criteria

The public deployment is available at Cloudflare Pages with a safe, reproducible deployment/rollback workflow. Missing authentication or project permission is a blocked, incomplete state; no unrelated provider is used.
