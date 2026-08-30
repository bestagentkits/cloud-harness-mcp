---
phase: 5
title: "Dashboard Workspace Opening, Toolkit Selector & Preview BFF"
status: pending
priority: P2
effort: "2d"
dependencies: ["phase-04-mount-injection-workspace-patching-and-worker-resolver.md"]
---

# Phase 5: Dashboard Workspace Opening, Toolkit Selector & Preview BFF

## Overview
Implement the dashboard BFF endpoints (`GET /api/v1/toolkits`, `POST /api/v1/toolkits/preview`, `POST /api/v1/workspaces`) and the Operator Dashboard UI components for interactive toolkit selection, scope configuration, provisioning-only secret binding, and pre-flight conflict preview.

<!-- red-team-applied: Findings 1, 4, 13 -->

## Requirements
- Functional:
  - Add internal dashboard BFF endpoints in `apps/api/src/dashboard-router.ts`:
    - `GET /api/v1/toolkits`: Lists available catalog presets with versions, scopes, licenses, and cache status (internal dashboard route, avoiding public MCP tool expansion).
    - `POST /api/v1/toolkits/preview`: Validates a proposed selection against runner policy and returns pre-flight analysis without executing network fetches or mutating state.
    - `POST /api/v1/workspaces`: Workspace opening endpoint executing `workspace_open` for dashboard operators.
  - Implement Dashboard UI components in `apps/api/dashboard/`:
    - **Open Workspace Modal**: Repository URL, ref, network mode, environment secrets, and toolkit selector.
    - **Toolkit Selection Cards**: Multi-select cards for Matt Pocock Skills, Superpowers, and AgentKit with badges (`Cached`, `Owner Overlay`, `Bootstrap Context`, `Secret Bound`).
    - **Scope Toggle**: Switch between `Owner Overlay (Clean Git)` and `Workspace Files (Modifies Repo)`.
    - **Secret Binding Selector**: Dropdown showing available secret names marked `purpose: "provisioning"` (e.g. `AGENTKIT_API_KEY`) without echoing secret values.
    - **Pre-Flight Preview Box**: Real-time summary of network policy, cache hits, resolved skill counts, and expected file writes.
    - **Workspace Detail View**: Renders resolved toolkit cards with content SHA-256, compatibility levels (`provisioned`, `discoverable`, `auto-activated`), and shadowed skills.
- Non-functional:
  - Complies with `docs/design-guidelines.md`: Mission control utilitarian styling, OKLCH colors, Safety Amber (`--accent`) actions, tabular numeric data, WCAG AA contrast (≥ 4.5:1), and `@media (prefers-reduced-motion: reduce)`.
  - Zero secret values ever enter the DOM, browser storage, or network response bodies.

## Architecture
```text
Browser Dashboard UI (apps/api/dashboard/)
  ├── Open Workspace Modal -> Toolkit Cards + Scope Switch + Secret Selector
  └── Calls Internal BFF Routes in apps/api/src/dashboard-router.ts
        ├── GET /api/v1/toolkits          -> Reads Internal Catalog
        ├── POST /api/v1/toolkits/preview -> Pre-flight validation & collision check
        └── POST /api/v1/workspaces       -> Dispatches workspace_open to Runner
```

## Related Code Files
- Modify: `apps/api/src/dashboard-router.ts`
- Modify: `apps/api/dashboard/index.html`
- Modify: `apps/api/dashboard/dashboard.js`
- Modify: `apps/api/dashboard/dashboard-render.js`
- Modify: `apps/api/dashboard/dashboard.css`
- Create: `apps/api/test/dashboard-toolkits-ui.test.ts`

## Implementation Steps
1. In `apps/api/src/dashboard-router.ts`:
   - Implement `GET /api/v1/toolkits` returning catalog presets from runner.
   - Implement `POST /api/v1/toolkits/preview` validating input against `ToolkitSelectionSchema` and returning cache/collision report.
   - Implement `POST /api/v1/workspaces` translating form input to `workspace_open` runner call.
2. In `apps/api/dashboard/index.html`:
   - Add "Open Workspace" button to the command toolbar.
   - Add the Open Workspace modal dialog with form fields, toolkit card grid, scope toggles, and preview box.
3. In `apps/api/dashboard/dashboard-render.js`:
   - Render toolkit cards dynamically with selection indicators.
   - Filter secret selector to display only secrets with `purpose: "provisioning"` for AgentKit binding.
   - Render pre-flight preview calculations on selection change.
   - Render resolved toolkit section on the workspace details panel.
4. In `apps/api/dashboard/dashboard.css`:
   - Add styles for `.toolkit-card-select`, `.check-indicator`, `.callout-box`, and theme tokens.
   - Ensure `@media (prefers-reduced-motion: reduce)` disables transition animations.
5. Write tests in `apps/api/test/dashboard-toolkits-ui.test.ts` and `apps/api/test/dashboard-ui-contract.test.ts`:
   - Verify modal DOM structure and accessible ARIA attributes.
   - Verify that secret values are never present in rendered DOM elements.

## Success Criteria
- [ ] Dashboard operator can open a workspace with selected toolkits through the UI.
- [ ] Pre-flight preview accurately calculates cache hits and file impact without executing network fetches.
- [ ] `apps/api/test/dashboard-ui-contract.test.ts` passes with zero contract violations.

## Risk Assessment
- *Risk:* Dashboard UI contract test fails due to unapproved inline styles or hex colors.
  - *Mitigation:* Use only CSS variables from `dashboard.css`, OKLCH colors, and adhere strictly to `docs/design-guidelines.md`.
