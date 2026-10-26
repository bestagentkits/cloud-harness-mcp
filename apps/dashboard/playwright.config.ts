import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.DASHBOARD_E2E_PORT ?? 4319);

// Smoke tests against the production build served by the real Express API. Run
// `npm run test:e2e:dashboard` from the repository root; it builds what the server needs.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure'
  },
  // Screenshots run as their own project, so their worker evaluates the fixtures under the
  // fixed clock (e2e/visual/freeze-time.ts) without leaking it into the behavioural specs.
  projects: [
    { name: 'chromium', testIgnore: /visual\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    { name: 'visual', testMatch: /visual\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } }
  ],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002 } },
  webServer: {
    command: 'node e2e/test-server.mjs',
    url: `http://127.0.0.1:${PORT}/healthz`,
    // Always start (and stop) our own server so no stale process serves an old build.
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe'
  }
});
