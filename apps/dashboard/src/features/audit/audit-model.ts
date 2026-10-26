/**
 * The retained audit projection (`audit_list` in `mapDashboardData`,
 * `apps/api/src/dashboard-response.ts`): redacted control-plane events, newest first, one
 * page of `AUDIT_PAGE_SIZE` with an opaque `cursor` for the next page.
 */
export type AuditEvent = {
  id?: string;
  action?: string;
  subjectType?: string;
  subjectId?: string;
  subjectGeneration?: number | string;
  details?: unknown;
  createdAt?: string;
};

/** The legacy page reads `/audit?limit=50`; the registry read uses the same query. */
export const AUDIT_PAGE_SIZE = 50;

/** The events of one page and the next-page cursor from an untrusted envelope body. */
export function auditPage(body: unknown): { events: AuditEvent[]; nextCursor: string | undefined } {
  const envelope = body && typeof body === 'object' ? (body as { data?: unknown; cursor?: unknown }) : {};
  const data = envelope.data && typeof envelope.data === 'object' ? (envelope.data as { events?: unknown }) : {};
  const events = Array.isArray(data.events) ? data.events.filter((event): event is AuditEvent => Boolean(event) && typeof event === 'object') : [];
  const nextCursor = typeof envelope.cursor === 'string' && envelope.cursor ? envelope.cursor : undefined;
  return { events, nextCursor };
}

/**
 * The redacted details as indented JSON text, for a `<pre>`. The server has already
 * redacted them; this only formats, and it never throws on a cyclic or exotic value.
 */
export function auditDetailsText(details: unknown): string {
  try {
    return JSON.stringify(details ?? {}, null, 2) ?? '{}';
  } catch {
    return '{}';
  }
}

/** Whether the redacted details carry anything worth expanding. */
export function hasAuditDetails(details: unknown): boolean {
  if (details === undefined || details === null) return false;
  if (typeof details === 'object') return Object.keys(details).length > 0;
  return true;
}
