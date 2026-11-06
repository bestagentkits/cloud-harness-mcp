import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api-client';
import type * as ApiClientModule from '@/lib/api-client';
import {
  APPROVAL_READS,
  approvalsApi,
  type PackagePlan,
  type PrivilegeGrant,
  formatPackageBytes,
  grantIsActionable,
  grantStatusLabel,
  pendingApprovals,
  planCanWithdraw,
  planIsActionable,
  planRisks,
  planStatusLabel,
  runtimeText,
  shortDigest
} from './approvals-model';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return { ...actual, apiClient: { request: vi.fn() } };
});

const request = vi.mocked(apiClient.request);
beforeEach(() => request.mockReset());

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const PAST = '2026-10-20T11:00:00.000Z';
const FUTURE = '2026-10-20T13:00:00.000Z';

const grant = (patch: Partial<PrivilegeGrant> = {}): PrivilegeGrant => ({
  id: 'grant-1', workspaceId: 'ws-1', command: 'npm install left-pad', status: 'PENDING', expiresAt: FUTURE, ...patch
});

const plan = (patch: Partial<PackagePlan> = {}): PackagePlan => ({
  planId: 'plan-1', planDigest: 'sha256:0123456789abcdef0123456789abcdef', status: 'PENDING_APPROVAL', name: 'left-pad', version: '1.3.0', expiresAt: FUTURE, ...patch
});

describe('grant state', () => {
  it('is actionable only while pending and unexpired', () => {
    expect(grantIsActionable(grant(), NOW)).toBe(true);
    expect(grantIsActionable(grant({ expiresAt: PAST }), NOW)).toBe(false);
    expect(grantIsActionable(grant({ status: 'APPROVED' }), NOW)).toBe(false);
  });

  it('treats an expiry equal to now as expired, and a missing or empty expiry as none', () => {
    expect(grantIsActionable(grant({ expiresAt: new Date(NOW).toISOString() }), NOW)).toBe(false);
    expect(grantIsActionable(grant({ expiresAt: null }), NOW)).toBe(true);
    expect(grantIsActionable(grant({ expiresAt: '' }), NOW)).toBe(true);
  });

  it('reads a pending grant past its expiry as Expired', () => {
    expect(grantStatusLabel(grant({ expiresAt: PAST }), NOW)).toBe('Expired');
    expect(grantStatusLabel(grant(), NOW)).toBe('Pending');
    expect(grantStatusLabel(grant({ status: 'APPROVED', expiresAt: PAST }), NOW)).toBe('Approved');
    expect(grantStatusLabel(grant({ status: 'CONSUMED' }), NOW)).toBe('Used');
    expect(grantStatusLabel(grant({ status: 'SOMETHING_NEW' }), NOW)).toBe('SOMETHING_NEW');
  });
});

describe('plan state', () => {
  it('is actionable only while pending and unexpired', () => {
    expect(planIsActionable(plan(), NOW)).toBe(true);
    expect(planIsActionable(plan({ expiresAt: PAST }), NOW)).toBe(false);
    expect(planIsActionable(plan({ status: 'APPROVED' }), NOW)).toBe(false);
  });

  it('allows withdrawal only of an approved plan that has not expired', () => {
    expect(planCanWithdraw(plan({ status: 'APPROVED' }), NOW)).toBe(true);
    expect(planCanWithdraw(plan({ status: 'APPROVED', expiresAt: PAST }), NOW)).toBe(false);
    expect(planCanWithdraw(plan(), NOW)).toBe(false);
  });

  it('labels each status, and reads an open plan past its expiry as Expired', () => {
    expect(planStatusLabel(plan(), NOW)).toBe('Pending');
    expect(planStatusLabel(plan({ status: 'APPROVED' }), NOW)).toBe('Approved, awaiting apply');
    expect(planStatusLabel(plan({ status: 'APPROVED', expiresAt: PAST }), NOW)).toBe('Expired');
    expect(planStatusLabel(plan({ expiresAt: PAST }), NOW)).toBe('Expired');
    expect(planStatusLabel(plan({ status: 'CONSUMED' }), NOW)).toBe('Applied');
    expect(planStatusLabel(plan({ status: 'REJECTED' }), NOW)).toBe('Rejected');
    expect(planStatusLabel(plan({ status: 'MYSTERY' }), NOW)).toBe('Unknown');
  });
});

describe('shortDigest', () => {
  const digest = 'sha256:0123456789abcdef0123456789abcdef';

  it('keeps the leading 12 and trailing 6 characters of a long digest', () => {
    expect(shortDigest(digest)).toBe('sha256:01234…abcdef');
  });

  it('leaves a digest of 20 characters or fewer unchanged', () => {
    expect(shortDigest('a'.repeat(20))).toBe('a'.repeat(20));
    expect(shortDigest('a'.repeat(21))).toBe(`${'a'.repeat(12)}…${'a'.repeat(6)}`);
  });
});

describe('formatPackageBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1536, '1.5 KiB'],
    [10_240, '10 KiB'],
    [1_048_576, '1.0 MiB'],
    [5 * 1024 ** 3, '5.0 GiB'],
    [1024 ** 5, '1024 TiB']
  ])('formats %d bytes as %s', (bytes, text) => {
    expect(formatPackageBytes(bytes)).toBe(text);
  });

  it.each([null, undefined, -1, 'not a number', Number.NaN])('reads %s as Unknown', (value) => {
    expect(formatPackageBytes(value)).toBe('Unknown');
  });
});

describe('runtimeText', () => {
  it('lists only the runtimes the plan reports, in a fixed order', () => {
    expect(runtimeText({ node: '20.11.1', npm: '10.2.4', python: null, uv: '' })).toBe('Node 20.11.1 · npm 10.2.4');
    expect(runtimeText({ uv: '0.4.0', python: '3.12.2' })).toBe('Python 3.12.2 · uv 0.4.0');
  });

  it('reports a missing runtime as not reported', () => {
    expect(runtimeText(null)).toBe('Not reported');
    expect(runtimeText({})).toBe('Not reported');
  });
});

describe('planRisks', () => {
  it('returns no risks for a plain plan', () => {
    expect(planRisks(plan())).toEqual([]);
  });

  it('warns about lifecycle scripts, collisions and a stale package, in that order', () => {
    const risks = planRisks(plan({
      lifecycleScripts: true,
      conflicts: [{ binary: 'tsc', name: 'typescript', scope: 'workspace' }, { binary: 'eslint', name: 'eslint-global' }],
      stale: true
    }));
    expect(risks).toEqual([
      'Runs npm lifecycle scripts while building. Install scripts execute package code in the builder.',
      'Binary name collisions: tsc (already provided by typescript in a workspace), eslint (already provided by eslint-global). The apply is refused until they are resolved.',
      'The package changed after this plan was made. Approval will be refused; create a new plan.'
    ]);
  });
});

describe('pendingApprovals', () => {
  it('counts only actionable grants and actionable plans for the nav badge', () => {
    const grants = [grant(), grant({ id: 'g2', expiresAt: PAST }), grant({ id: 'g3', status: 'APPROVED' })];
    const plans = [plan(), plan({ planId: 'p2', status: 'APPROVED' }), plan({ planId: 'p3', expiresAt: PAST })];
    expect(pendingApprovals(grants, plans, NOW)).toBe(2);
    expect(pendingApprovals([], [], NOW)).toBe(0);
  });
});

describe('approvalsApi', () => {
  it('decides a grant with an empty body on the encoded path', async () => {
    request.mockResolvedValue(undefined);
    await approvalsApi.decideGrant(grant({ id: 'grant/1' }), 'approve');
    await approvalsApi.decideGrant(grant({ id: 'grant-2' }), 'reject');
    expect(request).toHaveBeenNthCalledWith(1, '/privilege-grants/grant%2F1/approve', { method: 'POST', body: {} });
    expect(request).toHaveBeenNthCalledWith(2, '/privilege-grants/grant-2/reject', { method: 'POST', body: {} });
  });

  it('approves a plan by sending its digest, and rejects it with an empty body', async () => {
    request.mockResolvedValue(undefined);
    await approvalsApi.approvePlan(plan());
    await approvalsApi.rejectPlan(plan({ planId: 'plan-2' }));
    expect(request).toHaveBeenNthCalledWith(1, '/package-plans/plan-1/approve', { method: 'POST', body: { planDigest: 'sha256:0123456789abcdef0123456789abcdef' } });
    expect(request).toHaveBeenNthCalledWith(2, '/package-plans/plan-2/reject', { method: 'POST', body: {} });
  });

  it('names the read paths it invalidates', () => {
    expect(APPROVAL_READS).toEqual(['/privilege-grants', '/package-plans']);
  });
});
