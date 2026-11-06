# feat(dashboard): P3 migrate core pages to React with parity (#458)

Parent: #458 · Depends on P2

## Scope
Migrate, page by page (one PR per page group is fine), the P3 rows of the parity matrix: Overview, Workspaces list + Workspace cockpit tabs (excluding Terminal/Files/Git, which are P4), Agents (list, detail, spawn/follow-up/cancel, logs, usage), Activity + Approvals inbox (read side), Projects/Environments, Knowledge, Skills (library, registry, detail/editor, ZIP import), Audit, Profile, Settings (lifecycle, network profile, OAuth session, TypeSafe), Analytics/metrics.

For each page: same BFF endpoints (no API rewrite), same deep links and filters as URL search params, loading/refetching/empty/error/unavailable states, one primary action, polling with owner + budget per matrix.

## Gates
- Per page: Playwright behavioural spec replacing each class-(b)/(c) test listed for it in the matrix (not deleted until the replacement lands); screenshot regression in light/dark at 1280/768/375; axe clean.
- Query-count and poller check: moving between P3 pages starts no duplicate pollers and no request fan-out above the legacy baseline.
- BFF suites unchanged and green.

## Dependencies
P2. Coordinate with #416 (agents control plane), #394 (traces), #393 (profile spawn), #408 (repository explorer): re-host only what exists; do not implement their scope here.

## Rollback
Flag `legacy`. Pages not yet migrated link to the legacy shell route via the canary cookie switch.
