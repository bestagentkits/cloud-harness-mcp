---
phase: 5
title: "GTM Distribution Portal, Registries & Client Guides"
status: pending
priority: P2
effort: "5d"
dependencies: ["01", "03", "04"]
---

# Phase 05: GTM Distribution Portal, Registries & Client Guides

## Overview
Execute the Go-To-Market (GTM) strategy for CloudHarness. Establish official distribution channels across major Model Context Protocol (MCP) server registries, deliver 1-click client setup guides for Claude Desktop, Cursor, Codex, and OpenCode, upgrade the developer portal with credit management and usage analytics, and launch the staged marketing campaign across the three product milestones (OSS Community -> Dedicated Beta -> Pooled GA).

## Requirements
- **Functional:**
  - **Official MCP Registry Packaging:** Package and submit CloudHarness MCP to official directories: Smithery.ai (`@cloudharness/mcp`), mcp.so, PulseMCP, glama.ai, and GitHub MCP ecosystem index.
  - **Interactive 1-Click Client Setup:** Provide tailored copy-paste configuration snippets and automated setup instructions for:
    - Claude Desktop (`claude_desktop_config.json`)
    - Cursor IDE (`.cursor/mcp.json`)
    - Codex CLI / OpenCode / Cline / Roo Code / Orca
  - **Developer Portal & Web Dashboard Enhancement:**
    - Visual wallet balance widget with 1-click Polar.sh top-up.
    - Active workspace live session monitor (resource usage, elapsed time, current cost).
    - API Key generator with custom labels, expiration dates, and IP allowlist restrictions.
  - **Community Documentation Site (`docs-site/`):**
    - New section: "Self-Hosting Guide" (Step-by-step 1-click script instructions).
    - New section: "HaaS Cloud Quickstart" (Get started in 30 seconds with free $5 credits).
    - Technical deep-dive: "Why autonomous agents need remote sandboxing vs local execution".
  - **Staged Launch Campaign Assets:**
    - Milestone 1 (OSS Launch): "Show HN: CloudHarness - Open-source remote coding harness for AI agents".
    - Milestone 2 (Beta Dedicated Launch): Invite-only developer program for high-volume agent builders.
    - Milestone 3 (Public GA Launch): Product Hunt, Reddit (r/LocalLLaMA, r/Cursor), X technical benchmark threads.
- **Non-functional:**
  - Developer Experience: Time-to-first-tool-call < 60 seconds from landing page.
  - SEO & Discoverability: High-ranking keywords for "remote coding mcp", "cloud agent harness", "safe bash execution for claude".

## Architecture & GTM Conversion Funnel

```text
                        ┌────────────────────────────────────────────────────────┐
                        │          Top of Funnel: Discovery & Trust              │
                        │  - Official MCP Registries (Smithery, Glama, PulseMCP) │
                        │  - GitHub Open Source Repository (MIT License)         │
                        │  - Hacker News / X Technical Benchmarks                │
                        └───────────────────────────┬────────────────────────────┘
                                                    │
                                ┌───────────────────┴───────────────────┐
                                ▼                                       ▼
                 ┌─────────────────────────────┐         ┌─────────────────────────────┐
                 │   OSS Self-Host Route       │         │   Managed HaaS Cloud Route  │
                 │ - Run: curl .../install.sh  │         │ - Sign in with GitHub       │
                 │ - Full control on own VPS   │         │ - Instant $5 free credits   │
                 │ - Zero vendor lock-in       │         │ - Zero server maintenance   │
                 └──────────────┬──────────────┘         └──────────────┬──────────────┘
                                │                                       │
                                └───────────────────┬───────────────────┘
                                                    │
                                                    ▼
                        ┌────────────────────────────────────────────────────────┐
                        │              Long-Term Commercial Expansion            │
                        │  - Developer PAYG -> Pro Subscription ($29/mo)         │
                        │  - Teams & Enterprise Dedicated Nodes ($199/mo)        │
                        └────────────────────────────────────────────────────────┘
```

## Related Code Files
- Create: `docs-site/guides/claude-desktop-setup.md` (Claude Desktop setup walkthrough)
- Create: `docs-site/guides/cursor-setup.md` (Cursor IDE integration guide)
- Create: `docs-site/guides/self-hosting.md` (1-Click installer comprehensive documentation)
- Create: `docs-site/pricing.md` (Public pricing transparency and calculator)
- Modify: `apps/api/dashboard/index.html` (Add wallet balance, top-up modal, and active session counters)
- Modify: `apps/api/dashboard/dashboard.js` (Integrate Polar.sh checkout SDK and live cost polling)
- Create: `site/launch/show-hn-announcement.md` (Launch copy and technical narrative)

## Implementation Steps
1. **Develop Client Integration Guides (`docs-site/guides/`):**
   - Create step-by-step guides with animated screenshots demonstrating tool connection.
   - Include auto-configuring CLI command: `npx cloudharness setup-client claude` or `npx cloudharness setup-client cursor`.
2. **Upgrade Dashboard UI (`apps/api/dashboard/`):**
   - Add "Credits & Billing" tab rendering current balance, monthly spend, and top-up buttons ($10, $25, $50).
   - Embed active session cards displaying real-time elapsed seconds, compute tier, and live cost calculation.
3. **Package MCP Registry Manifests:**
   - Author `smithery.yaml` with automated schema reflection.
   - Register metadata, tags (`ai-agents`, `sandbox`, `coding-harness`, `secure-bash`), and verified author badges.
4. **Author Launch Content & Technical Whitepaper:**
   - Draft technical post: "Building a Production Remote Coding Harness for AI Agents: Security, Firecracker MicroVMs, and Sandboxing Lessons".
   - Prepare benchmark tests measuring latency overhead of MCP tool calls vs local bash.
5. **SEO & Landing Page Polish:**
   - Update `site/index.html` with interactive pricing calculator slider (adjusting hours and workspace sizes).
   - Ensure clear call-to-action buttons: "Deploy Open Source" vs "Try Managed Cloud Free ($5 Credit)".

## Success Criteria
- [ ] Smithery.ai and PulseMCP successfully index CloudHarness MCP with passing automated verification tests.
- [ ] User copying the configuration snippet into Cursor connects to CloudHarness in < 30 seconds.
- [ ] Dashboard displays accurate real-time balance and completes test credit purchase via Polar.sh.
- [ ] Documentation site builds with zero broken links and full mobile responsiveness.
- [ ] Community launch announcement published to Hacker News, Reddit, and X.

## Risk Assessment
- **Risk:** High drop-off rate during client configuration if JSON snippet formatting is error-prone.
  - *Observable Signal:* Registrations occur but zero tool calls follow.
  - *Response:* Provide an interactive web wizard that generates a downloadable pre-formatted config file or a 1-line `npx` auto-configurator command.
- **Risk:** Free credit abuse from disposable bot accounts.
  - *Observable Signal:* Spike in account creations with zero GitHub activity.
  - *Response:* Require GitHub account age > 30 days or credit card pre-authorization before granting free trial credits.
