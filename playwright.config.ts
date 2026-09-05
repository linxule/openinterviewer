import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_PORT || 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'standalone-direct',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'standalone-gateway',
      testMatch: '**/research-workflow.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PORT + 1}` },
    },
  ],
  webServer: {
    command: `node tests/e2e/server.mjs launch ${PORT}`,
    // The Gateway server is started only after the single production build.
    url: `http://127.0.0.1:${PORT + 1}`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
  },
});
