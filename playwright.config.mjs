import { defineConfig } from '@playwright/test';

const deployedURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  use: { baseURL: deployedURL || 'http://127.0.0.1:3100', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: deployedURL ? undefined : {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:3100/api/dashboard',
    env: { PORT: '3100', DB_PATH: ':memory:' },
    reuseExistingServer: false,
  },
});
