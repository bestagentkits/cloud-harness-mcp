import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { createAppRouter } from './router';

// The API answers 200 only for the route prefixes in DASHBOARD_REACT_ROUTES and 404s every
// other navigation. Read the list from its owner so a new route cannot ship unreachable.
const apiSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../api/src/dashboard-react-assets.ts'), 'utf8');
const listed = /DASHBOARD_REACT_ROUTES: readonly string\[\] = \[([^\]]*)\]/.exec(apiSource)?.[1];
const allowlist = [...(listed ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]);

function isAllowed(path: string): boolean {
  return allowlist.some((route) => route === '/' ? path === '/' : path === route || path.startsWith(`${route}/`));
}

describe('server route allowlist', () => {
  it('covers every route in the route tree', () => {
    expect(allowlist.length).toBeGreaterThan(0);
    const router = createAppRouter(new QueryClient(), createMemoryHistory({ initialEntries: ['/dashboard/'] }));
    const paths = Object.keys(router.routesByPath).map((path) => path.replace(/\/\$[^/]*/g, '/x') || '/');
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(isAllowed(path), path).toBe(true);
  });
});
