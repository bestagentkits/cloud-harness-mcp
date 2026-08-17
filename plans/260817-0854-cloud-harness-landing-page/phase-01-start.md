---
title: "Phase 1: Define the static surface"
status: todo
---

# Phase 1: Define the static surface

## Overview

Identify the landing-page facts and create an intentionally small static-site boundary.

## Requirements

- [x] Use README, MCP API, system architecture, and security model as product-claim sources.
- [x] Keep the landing page separate from the VPS-hosted Docker application.
- [x] Use a static HTML/CSS/JavaScript surface with no secrets, API credentials, analytics, or build-time configuration.
- [x] Reserve the existing MCP hostname for nginx; Pages may use only its generated hostname or a separately approved custom domain.

## Implementation Steps

1. Extract product vocabulary, tool semantics, topology, and restrictions from project documentation into a claim-to-source checklist.
2. Define a compact `site/` artifact and Cloudflare Pages configuration.
3. Confirm the visual direction, content sections, accessibility requirements, and deployment boundary.

## Todo

- [x] Establish the copy and security guardrails, including non-hostile-tenant, default-network, lifecycle, and Git-push qualifiers.
- [x] Establish the static-site and deployment-file ownership.

## Success Criteria

The scope names exact source documents, contains no unverified product claims, and avoids interaction with the private runtime.
