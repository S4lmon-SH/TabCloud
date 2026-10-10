import { defineConfig, devices } from '@playwright/test';

const externalBaseURL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: externalBaseURL ?? 'http://127.0.0.1:3001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome']
  },
  webServer: externalBaseURL ? undefined : {
    command: 'pnpm start',
    url: 'http://127.0.0.1:3001/healthz',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: { PORT: '3001', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://127.0.0.1:3001' }
  }
});
