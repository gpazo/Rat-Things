import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RAT_THINGS_SITE_PORT ?? 4173);

export default defineConfig({
  testDir: "./e2e/site",
  testMatch: "**/*.browser.ts",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  outputDir: "test-results/site",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--enable-webgl",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: {
    command: `npm run site:build && node scripts/serve-site.mjs --port=${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
