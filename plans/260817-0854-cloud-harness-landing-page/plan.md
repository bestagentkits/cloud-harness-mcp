---
title: "Cloud Harness landing page"
description: ""
status: completed
priority: P1
effort: "1d"
branch: feat/cloud-harness-landing
tags: [landing-page, static-site, cloudflare-pages]
created: 2026-08-17
---

# Cloud Harness landing page

## Overview

Create a production-ready static landing page that explains Cloud Harness MCP's
remote coding workflow, preserves the project's single-owner security message,
and can be deployed independently to Cloudflare Pages.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Present the harness as a clear, technically credible developer product. | P1 |
| 2 | Keep marketing copy aligned with the README and security-model claims. | P1 |
| 3 | Publish the static artifact through Cloudflare Pages without changing the VPS service. | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Define the static surface](./phase-01-start.md) | Pending |
| 2 | [Implement the landing page](./phase-02-implement-static-landing.md) | Pending |
| 3 | [Verify and publish](./phase-03-verify-and-publish-cloudflare-pages.md) | Pending |

## Success Criteria

- [ ] The page communicates the MCP-to-executor workflow and its single-owner, non-hostile-tenant boundary accurately.
- [ ] The website is responsive, accessible, visually distinctive, and needs no runtime secret or backend.
- [ ] A reproducible Cloudflare Pages deployment command and rollback process are documented.
- [ ] The page is published to an isolated Cloudflare Pages hostname and its public URL, links, and owner-boundary copy are smoke-tested.

## Non-goals

- Moving or proxying the MCP API through Cloudflare Pages.
- Changing Docker, API, runner, authentication, or VPS deployment behavior.
- Claiming multi-tenant isolation, hosted credentials, or functionality that the repository does not implement.
- Binding or redirecting the existing MCP hostname, which remains owned by the VPS nginx deployment.

## Claim guardrails

- Product claims are sourced from `README.md`, `docs/system-architecture.md`, `docs/security-model.md`, and `docs/mcp-api.md`.
- The page must say that it is a private, single-owner service, repository code remains untrusted execution input, and the Docker/shared-kernel controls are not a hostile multi-tenant boundary.
- It must not imply persistent workspaces, default executor egress, Git push, or executor access to deployment or repository credentials.

## Red Team Review

### Accepted findings

- Make the single-owner/non-hostile-tenant limitation visible alongside the architecture story.
- Use `docs/mcp-api.md` for capability claims and explicit lifecycle/network/Git qualifiers.
- Pin the Pages CLI in the project, add preflight/deploy/rollback scripts, and document the target project and rollback selection.
- Use absolute GitHub documentation URLs and validate every deployed outbound link.
- Add a static-artifact secret inventory, accessibility checklist, and explicit Pages-hostname/DNS safeguard.
- Keep the Pages guide separate from the VPS deployment guide and add it to README navigation.

### Whole-Plan Consistency Sweep

- Reconciled the completion rule: unavailable Cloudflare credentials block publication rather than count as success.
- Reconciled page copy, verification, and deployment work so they all prohibit misleading isolation claims and control-plane secrets.

<!-- slug: cloud-harness-landing-page -->
