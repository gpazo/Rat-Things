import { defineConfig, devices } from '@playwright/test';

process.umask(0o077);

const recordSuccessfulDemo = process.env.RAT_THINGS_CONSOLE_VIDEO === 'on';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results/console',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1_280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: {
      mode: recordSuccessfulDemo ? 'on' : 'retain-on-failure',
      size: { width: 1_280, height: 800 },
    },
  },
});
