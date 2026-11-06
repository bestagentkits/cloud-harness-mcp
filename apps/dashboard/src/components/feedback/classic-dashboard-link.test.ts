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

  it('keeps the page query and replaces any ui parameter', () => {
    expect(classicDashboardHref('/dashboard/agents', '?status=RUNNING')).toBe('/dashboard/agents?status=RUNNING&ui=legacy');
    expect(classicDashboardHref('/dashboard/integrations/github', '?installation_id=42&state=abc&ui=react')).toBe('/dashboard/integrations/github?installation_id=42&state=abc&ui=legacy');
  });
});
