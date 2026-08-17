---
title: "Getting Started And MCP Tools"
description: "Add a safe entry path and a source-aligned public inventory of Cloud Harness MCP tools."
status: completed
priority: P1
effort: "2h"
branch: feat/animated-mcp-website
linked_pr: 27
tags: [readme, landing-page, mcp]
created: 2026-08-17
---

# Getting Started And MCP Tools

## Overview

Give trusted owners a short, safe start path and a grouped inventory of the
public MCP tool names. The contract schema remains authoritative for names and
input behavior.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Publish a Getting Started path in README and landing page | P1 |
| 2 | List every public tool by operational category | P1 |
| 3 | Verify the static page and the inventory against the contract | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Define the public contract](./phase-01-start.md) | Completed |
| 2 | [Publish Getting Started and tool inventory](./phase-02-publish-getting-started-and-tool-inventory.md) | Completed |
| 3 | [Validate public documentation and page](./phase-03-validate-public-documentation-and-page.md) | Completed |

## Success Criteria

- [x] README guides an owner from a supported client to opening, working in,
  and closing a workspace without embedding a credential.
- [x] README and landing page list exactly the public names in
  `RunnerOperationSchema`, grouped so an owner can choose an operation.
- [x] The page is responsive, keyboard usable, motion-safe, and passes its
  artifact/link checks.

<!-- slug: getting-started-and-mcp-tools -->
