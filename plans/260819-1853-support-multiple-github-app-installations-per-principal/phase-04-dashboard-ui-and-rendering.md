---
phase: 4
title: "Dashboard UI and Rendering"
status: completed
priority: P1
effort: "1h"
dependencies: [3]
---

# Phase 4: Dashboard UI and Rendering

## Overview
Update `apps/api/dashboard/dashboard-render.js`, `apps/api/dashboard/dashboard.js`, and styling to render multiple GitHub App installations, provide per-installation Reconcile and Disconnect buttons, render authorized repositories per installation/owner, and update overview stats.

## Requirements
- Functional:
  - `renderGitHub` in `apps/api/dashboard/dashboard-render.js`:
    - Renders an installation panel or list of cards when `status.installations` is non-empty.
    - Each installation card displays:
      - Account login (`accountLogin` or `accountId`)
      - Installation status (`active`, `suspended`, `uninstalled`)
      - Installation ID (mono)
      - Last checked timestamp
      - Action buttons: "Reconcile" and "Disconnect" (with data attributes `data-installation-id="..."`)
    - When `status.installations` is empty: displays "No GitHub App installation is bound to this identity."
    - "Connect GitHub App" panel with optional expected account ID input and "Connect GitHub App" button to connect additional accounts/orgs.
    - "Authorized repositories" list displaying owner/repo, status, contents permissions, and associated installation ID.
  - Event Handling in `apps/api/dashboard/dashboard.js`:
    - Binds click listeners to per-installation Reconcile buttons (calls `POST /api/v1/github/reconcile` with `{ installationId }`).
    - Binds click listeners to per-installation Disconnect buttons (prompts/confirms and calls `POST /api/v1/github/disconnect` or `DELETE /api/v1/github/installations/:id`).
    - Overview tile displays count/summary of connected installations (e.g. `2 connected` or account names).
  - Contract & UI Tests:
    - `apps/api/test/dashboard-ui-contract.test.ts`
    - `apps/api/test/dashboard-ui-behavior.test.ts`
- Non-functional:
  - Accessible HTML with proper ARIA attributes, semantic headings, and keyboard navigation.
  - Zero external CDN dependencies, conforms to strict CSP.

## Related Code Files
- Modify: `apps/api/dashboard/dashboard-render.js`
- Modify: `apps/api/dashboard/dashboard.js`
- Modify: `apps/api/dashboard/dashboard.css` (if needed for styling installation cards)
- Modify: `apps/api/test/dashboard-ui-contract.test.ts`
- Modify: `apps/api/test/dashboard-ui-behavior.test.ts`

## Implementation Steps (TDD)
1. **Tests First:**
   - In `apps/api/test/dashboard-ui-contract.test.ts`: test HTML structure when `installations` contains multiple records; test presence of per-installation action buttons and repository list.
   - In `apps/api/test/dashboard-ui-behavior.test.ts`: test clicking reconcile and disconnect for a specific installation.
2. **Implement `dashboard-render.js`:**
   - Update `renderGitHub` to iterate over `status.installations`.
3. **Implement `dashboard.js`:**
   - Update `bindGitHubControls` to attach event listeners to all reconcile and disconnect buttons.
   - Update overview panel logic.
4. **Run and Verify Tests:**
   - `npx vitest run apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-ui-behavior.test.ts`

## Success Criteria
- [x] Operator dashboard lists each connected GitHub App installation.
- [x] Operator can trigger reconcile or disconnect on an individual installation.
- [x] Operator can initiate connection for additional organizations.
- [x] UI contract and behavior tests pass.
