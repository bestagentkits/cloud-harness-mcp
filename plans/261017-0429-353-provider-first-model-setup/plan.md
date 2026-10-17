# Provider-first model setup (#353)

Status: in progress. Umbrella issue: #353. Integration branch: `dev`.

## Outcome

An operator connects a supported provider, searches and selects a model,
verifies the route, and saves an operational profile in about a minute without
knowing model IDs, endpoints, or token prices. Advanced/custom configuration
and API/MCP configuration remain available. Encrypted credentials, gateway
snapshots, immutable revisions, lease pinning, and principal isolation stay
intact.

## Constraints and non-goals

- Credentials never leave the runner/gateway: not to the browser, workspace,
  logs, or error messages.
- Outbound catalog and verification requests go only to registry hosts (or the
  operator's HTTPS custom upstream) with address validation and DNS pinning.
- No ChatGPT consumer-session scraping; extra auth adapters ship only with an
  officially documented integration contract.
- Not a generalized billing platform: per-run caps are hard limits; aggregate
  spend figures are labelled as estimates.

## Phases (one PR each, merged to `dev` in order)

| Phase | Scope | Priority | Depends on |
| --- | --- | --- | --- |
| 1 (#354) | Typed provider registry in contracts; Gemini OpenAI-compatible endpoint fix; API-mode compatibility enforcement; DeepSeek; custom-profile edit keeps its URL; `GET /api/v1/model-providers` | P0 (bug) | — |
| 2 (#355) | Server-side model catalog (provider models endpoints + OpenRouter metadata), TTL cache with last-good snapshot, decimal-safe price normalization with provenance, search/refresh API | P0 | 1 |
| 3 (#356) | Bounded connection/model verification with structured outcomes, rate limits, audit, persisted last result | P0 | 1 |
| 4 (#357) | Dashboard provider-first wizard: searchable combobox, auto-filled review, verify-before-save, Advanced settings, permission presets, richer profile list | P0/P1 | 2, 3 |
| 5 (#358) | Pricing provenance and overrides on revisions, cache-aware usage accounting, input-token estimate review, aggregate spend policies | P1 | 2 |
| 6 (#359) | MCP/API parity for catalog, verify, profile management, budget usage; extra auth adapters after feasibility | P2 | 2, 3, 5 |

## Acceptance criteria

Tracked on #353; each phase PR lists the criteria it closes with test evidence.

## Validation per phase

Focused unit tests first, then `npm run verify`. Dashboard phases add DOM
contract tests. Docs (`docs/`, `docs-site/dashboard/models.md`,
`docs-site/reference/`) and the cloudharness skill update with the surface.
