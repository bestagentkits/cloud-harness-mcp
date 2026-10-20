import { compact, oauthOutcome, oneOf } from '@/lib/search-params';

// Kept apart from the page module: the route file imports this validator eagerly, and the
// page itself must stay in its lazily loaded route chunk.

export const MCP_DETAIL_TABS = ['overview', 'tools', 'permissions', 'logs'] as const;
export type McpDetailTab = (typeof MCP_DETAIL_TABS)[number];

/** The detail page's deep-link params; re-applied to `useSearch()`, which also carries parents' raw keys. */
export function mcpDetailSearch(raw: Record<string, unknown>) {
  return compact({ ...oauthOutcome(raw), tab: oneOf(raw, 'tab', MCP_DETAIL_TABS) });
}
