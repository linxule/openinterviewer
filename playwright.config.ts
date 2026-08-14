import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_PORT || 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT} -H 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      ...process.env,
      DEPLOYMENT_MODE: process.env.DEPLOYMENT_MODE || 'standalone',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'e2e-test-password',
      SESSION_SECRET: process.env.SESSION_SECRET || 'e2e-test-session-secret',
      PARTICIPANT_TOKEN_SECRET: process.env.PARTICIPANT_TOKEN_SECRET || 'e2e-test-token-secret',
      GEMINI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      KV_URL: '',
      KV_REST_API_URL: '',
      KV_REST_API_TOKEN: '',
      KV_REST_API_READ_ONLY_TOKEN: '',
      REDIS_URL: '',
    },
  },
});
