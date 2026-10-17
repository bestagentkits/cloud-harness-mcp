# Phase 6: Dashboard pricing and spend UI

This phase lands last. It starts after #357 merges, because #357 adds `apps/api/dashboard/dashboard-models.js`, and after phase 5, which provides the API.

Owner files:
- `apps/api/dashboard/{dashboard-models.js, dashboard-api.js, dashboard.css}`
- `apps/api/test/dashboard-ui-contract.test.ts`, plus the models DOM test that #357 adds
- `docs-site/dashboard/models.md`, `docs/design-guidelines.md` (only if a new component pattern is introduced)

MCP skill / `docs/mcp-api.md`: no change.

Re-scout `dashboard-models.js` once #357 lands. The file does not exist on `origin/dev`, so every location below is described by function. The implementer cites the exact lines in the PR.

## Requirements

1. **Wizard save.** When a catalog price is accepted unchanged, send `catalogPriceRef: {sourceModelId}` (phase 3). When a price field is edited, the save is labelled "Custom price (override)".
2. **Profile list and detail.**
   - Show the price source, confidence, retrieval date, and override badge from `priceProvenance`.
   - Show cache-read and cache-write prices, and tiers when present. An unknown price displays as "Unknown (charged conservatively)", never "$0".
   - When `pricingReview.state === 'repriced'`, show a warning badge: "Catalog price changed by N% since saved". The badge offers an action that opens the edit form pre-filled with the catalog price; nothing is applied automatically. For an override, the badge reads "Differs from catalog" instead.
3. **Spend panel** on the Models & Budgets page (`GET /api/v1/model-spend`).
   - Show today's and this month's totals per principal and per profile, split into settled, reserved, and unreconciled.
   - Show the threshold state as `ok`, `warning`, or `exceeded`, following the HUD status colours in `docs/design-guidelines.md`.
   - Every figure carries an "Estimate" label, and a help note explains that a run's cap is reserved until the run ends.
4. **Policy editor.** Create, edit, and delete daily or monthly limits for the principal or for a profile, with the warn percentage. Sends use `expectedGeneration`; a conflict re-fetches. Errors come from the API's pass-through text.
5. **Accessibility.** Badges and states have text equivalents, not colour alone. Inputs are labelled, and the money input accepts USD and converts to micros on the client with integer maths.

## Tests

- DOM contract tests:
  - provenance badges and the unknown-price text;
  - the repriced badge, with both its override and non-override wording;
  - the spend panel's Estimate labels and threshold classes;
  - the policy editor's create, conflict, and delete flows against stubbed API responses;
  - the wizard sending `catalogPriceRef` only for unedited prices.
- Then `npm run verify`.

## Docs

- `docs-site/dashboard/models.md`: walkthrough of the provenance display, repricing warning, spend panel, and policy editor. Keep the wording identical to the UI labels.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| #357 shifts the file structure | H×L | Re-scout before coding. This phase owns no file that #357 is still editing. |
| USD-to-micros rounding | L×M | Integer string parsing, with a unit test at 6 decimal places. |

## Rollback

Revert the PR. The API and the enforcement keep working without the UI.
