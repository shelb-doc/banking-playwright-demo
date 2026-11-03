import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  use: { baseURL: 'http://127.0.0.1:3100', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:3100/api/dashboard',
    env: { PORT: '3100', DB_PATH: ':memory:' },
    reuseExistingServer: false,
  },
});
