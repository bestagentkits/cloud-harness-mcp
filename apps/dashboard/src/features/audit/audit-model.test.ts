import { describe, expect, it } from 'vitest';
import { pageReadQuery } from '@/lib/page-read';
import { auditDetailsText, auditPage, hasAuditDetails } from './audit-model';
import { auditPageQuery } from './audit-query';

describe('audit page read', () => {
  it('shares the registry read key on the first page, so the warm prefetch is reused', () => {
    expect(auditPageQuery(undefined).queryKey).toEqual(pageReadQuery('audit', {}).queryKey);
    expect(auditPageQuery('c_2').queryKey).toEqual(['bff', '/audit', { limit: 50, cursor: 'c_2' }]);
  });

  it('reads events and the next cursor from an untrusted envelope', () => {
    expect(auditPage({ data: { events: [{ id: 'a' }, null, 'x'] }, cursor: 'c_2' })).toEqual({ events: [{ id: 'a' }], nextCursor: 'c_2' });
    expect(auditPage({ data: {} })).toEqual({ events: [], nextCursor: undefined });
    expect(auditPage({ data: { events: [] }, cursor: 7 }).nextCursor).toBeUndefined();
  });

  it('formats details without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(auditDetailsText(cyclic)).toBe('{}');
    expect(auditDetailsText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(auditDetailsText(undefined)).toBe('{}');
    expect(hasAuditDetails({})).toBe(false);
    expect(hasAuditDetails(null)).toBe(false);
    expect(hasAuditDetails({ a: 1 })).toBe(true);
  });
});
