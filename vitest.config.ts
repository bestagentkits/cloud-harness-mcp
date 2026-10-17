import { defineConfig } from 'vitest/config';

// Only adds a per-run temp directory; test selection stays on vitest defaults and the
// CLI filters in package.json.
export default defineConfig({
  test: {
    globalSetup: ['./test/vitest-global-setup.ts']
  }
});
