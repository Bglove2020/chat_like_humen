import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 120000,
  expect: {
    timeout: 15000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
});
