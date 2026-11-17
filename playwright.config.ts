import { defineConfig, devices } from 'playwright/test';

// Chromium runs by default using the "chrome" channel (Chrome for Testing has H.264/AAC
// codecs; the open-source Chromium build does not). Firefox and WebKit are opt-in with
// E2E_ALL_BROWSERS=1 because their binaries must be installed separately
// (`npx playwright install firefox webkit`) and their HLS support differs — see
// docs/FEATURE_MATRIX.md.
const all = process.env.E2E_ALL_BROWSERS === '1';
const port = Number(process.env.FIXTURE_PORT ?? 8080);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // tests share the fixture server's fault table
  retries: 0, // flaky tests must be fixed, not retried
  reporter: [['list'], ['json', { outputFile: 'reports/e2e-results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node infrastructure/fixtures/server.mjs',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: !process.env.CI,
    env: { FIXTURE_QUIET: '1', FIXTURE_FAULTS: '1', FIXTURE_PORT: String(port) },
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    ...(all
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
});
