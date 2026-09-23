import { defineConfig, devices } from '@playwright/test';

// Cloudflare production-artifact browser lane (VERIFY-02). Requires
// `npm run build:cloudflare` first; the server runs that artifact in local
// workerd with real Durable Object storage, alarms and Queue consumption.
const PORT = Number(process.env.PLAYWRIGHT_CLOUDFLARE_PORT || 3200);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e-cloudflare',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-cloudflare' }]],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'cloudflare-artifact', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tests/e2e-cloudflare/server.mjs ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
