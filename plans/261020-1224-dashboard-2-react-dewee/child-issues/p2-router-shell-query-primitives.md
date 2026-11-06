# feat(dashboard): P2 router, app shell, navigation transaction, query client and UI primitives (#458)

Parent: #458 · Depends on P1

## Scope
- TanStack Router file routes for every page key in the parity matrix (route table + legacy redirects + deep-link params as typed search params). Route identity drives URL, active nav, breadcrumb/eyebrow, `document.title`, primary page action and content.
- App shell: collapsible sidebar from a typed page registry, top bar (theme cycle, display-name chip, command palette trigger, workspace filter), footer; responsive mobile drawer.
- Navigation transaction: B shell + skeleton or cached B data render synchronously; obsolete reads aborted via Query `signal`; late results fenced by query key; mutations never cancelled by navigation.
- `lib/api-client.ts`: same-origin fetch, CSRF header from the session bootstrap, typed errors for 401/403/409/429/5xx, `session_ended` handling, no secret logging.
- `lib/query-client.ts`: in-memory only, no persistence; staleness/poll defaults; one owner per poller with visibility pause.
- Feedback system: Skeleton, Empty, Error (retry), AsyncStatus, Toast, Progress (indeterminate only when duration unknown), nav progress bar.
- Primitives: Button (pending/success/error, no double-submit), Dialog/Drawer/Popover/Tooltip/Tabs/Combobox/Confirm/Copy, DataTable; dialog rules from ADR 0005 (dismissible outside click + Escape + focus restore, dirty-form guard, reveal acknowledgement, destructive in-flight lock).
- Preferences: text size, density (localStorage, non-secret), theme via existing `PUT /api/v1/preferences` cookie; reduced-motion respected.
- Command palette with page commands and global shortcuts that do not collide with terminal focus.

## Gates
- Playwright: A→B, A→B→C, rapid repeat click, slow + out-of-order responses (route-level network stubs), failed fetch, refresh, Back/Forward — zero title/nav/content mismatches; nav visual response p95 < 100 ms measured with documented method.
- 401/403/409/429/5xx states covered; axe clean on shell; keyboard-only navigation; reduced motion.
- Unit tests for api-client CSRF/error mapping and preference storage (asserting no secret keys ever written).

## Dependencies
P1.

## Rollback
Behind the P1 flag; legacy remains default.
