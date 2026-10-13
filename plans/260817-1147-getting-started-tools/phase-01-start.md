---
title: "Define The Public Contract"
status: completed
---

# Phase 1: Define The Public Contract

## Overview

Identify the public tool authority and the minimal safe workflow before
writing explanatory content.

## Requirements

- [x] Use `RunnerOperationSchema` as the exact tool-name authority.
- [x] Use `docs/mcp-api.md` as the lifecycle and security authority.

## Implementation Steps

1. Map the safe workflow: configured client, `workspace_open`, opaque
   `workspaceId`, bounded work, and `workspace_close`.
2. Group the public operations without copying their schemas or bounds.

## Todo

- [x] Confirm `apps/api/src/mcp-server.ts` registers every `TOOL_SPECS`.
- [x] Confirm tool groups against the contract enum.

## Success Criteria

All planned names and workflow claims have an executable/documented source.
