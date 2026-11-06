import { configDefaults, defineConfig } from 'vitest/config';

// Adds a per-run temp directory; test selection stays on vitest defaults and the CLI
// filters in package.json. The React Dashboard runs its own jsdom suite with its own
// config (`npm run test -w @cloud-harness/dashboard`), so the root run skips it.
export default defineConfig({
  test: {
    globalSetup: ['./test/vitest-global-setup.ts'],
    exclude: [...configDefaults.exclude, 'apps/dashboard/**']
  }
});
