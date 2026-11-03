import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-test', workers: 1, fullyParallel: false, timeout: 45000,
  expect: { timeout: 12000 }, reporter: [['list']],
  // No traces/video: request headers contain ephemeral credentials.
  use: { browserName: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, trace: 'off', video: 'off', screenshot: 'off' },
});
