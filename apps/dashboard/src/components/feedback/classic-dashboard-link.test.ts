import { describe, expect, it } from 'vitest';
import { classicDashboardHref } from './classic-dashboard-link';

describe('classicDashboardHref', () => {
  it('keeps the Dashboard path and adds only ui=legacy', () => {
    expect(classicDashboardHref('/dashboard')).toBe('/dashboard?ui=legacy');
    expect(classicDashboardHref('/dashboard/')).toBe('/dashboard/?ui=legacy');
    expect(classicDashboardHref('/dashboard/workspaces/ws-1')).toBe('/dashboard/workspaces/ws-1?ui=legacy');
    // A router pathname without the basepath still lands under /dashboard.
    expect(classicDashboardHref('/')).toBe('/dashboard?ui=legacy');
    expect(classicDashboardHref('/workspaces')).toBe('/dashboard/workspaces?ui=legacy');
  });
});
