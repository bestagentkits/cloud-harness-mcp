---
title: Resolve ChatGPT Developer MCP FORBIDDEN gating and documentation parity
date: 2026-09-01
summary: Documented ChatGPT Developer Mode draft lifecycle, published custom connector workflow, conversation capability constraints, and troubleshooting for FORBIDDEN developer MCP rejections
---

# Resolve ChatGPT Developer MCP FORBIDDEN gating and documentation parity

## Problem
In issue #171, users reported that CloudHarness MCP tools are successfully scanned and discovered in ChatGPT after OAuth registration, but tool execution (e.g. `workspace_open`) is rejected with `FORBIDDEN: This conversation does not support developer MCPs`.

## Diagnosis & Root Cause
ChatGPT distinguishes between draft Developer MCPs (custom apps created in Developer Mode with the `Dev` tag) and approved workspace Custom Connectors (published by admins with the `custom` tag).
1. When registered as a custom app, ChatGPT places it in Draft state. In this mode, tool execution is restricted to standard 1-on-1 ChatGPT Web conversations where Developer Mode is explicitly enabled in the user's account settings.
2. Attempting to invoke developer MCPs within unsupported conversation contexts (Custom GPTs, Project chats, Canvas, Mobile apps, Temporary chats, or accounts with Developer Mode disabled) triggers `FORBIDDEN: This conversation does not support developer MCPs` on the ChatGPT platform before or during tool invocation.
3. OpenAI restricts full MCP execution (write actions) to Business, Enterprise, and Edu plans (beta).
4. CloudHarness's documentation lacked guidance on Developer Mode vs. Published Connector lifecycles, conversation surface constraints, and troubleshooting playbooks for this error. Note that server-side hiding of tools at discovery time is not feasible within MCP protocol constraints because `tools/list` responses are session-static and ChatGPT does not transmit per-conversation developer mode capability state during tool discovery.

## Solution
1. **Enhanced `docs-site/ai-tools/chatgpt.md`**: Added detailed breakdowns of Developer Mode (Draft) vs. Workspace Published Custom Connector lifecycles, conversation prerequisites, and a comprehensive troubleshooting section for `FORBIDDEN: This conversation does not support developer MCPs` detailing root causes and concrete fixes.
2. **Updated `docs-site/troubleshooting.md`**: Added item #8 detailing cause, verification, and resolution steps for ChatGPT developer MCP invocation rejections.
3. **Updated `README.md`**: Clarified the ChatGPT client setup to cover draft testing vs. workspace publishing and direct links to the troubleshooting playbook.
4. **Updated skill references & synced plugin**: Added concise ChatGPT execution mode guidance with public URLs in `.agents/skills/cloudharness/references/installation-and-security.md` and synchronized byte-identically with `plugins/cloud-harness/`.
5. **Verified**: Validated via `npm run docs:links`, `npm run docs:build`, `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`, `npm run typecheck`, `npm run lint`, and `npm run test:unit`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
