import { defineConfig } from "@playwright/test";

// End-to-end tests drive real browsers against the real stack (API, worker, dashboard, demo app).
// Locally they use your installed Google Chrome; set PW_CHANNEL=chromium to use Playwright's own
// browser instead (that is what CI does, after `npx playwright install chromium`).
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  // One shared stack and one database: tests run one at a time, in order
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // In CI, "github" also turns each failed test into an annotation on the run, so the reason is visible without downloading logs
  reporter: [["list"], ...(process.env.CI ? [["github"] as ["github"]] : []), ["html", { open: "never", outputFolder: "tests/e2e/report" }]],
  outputDir: "tests/e2e/results",
  use: {
    channel: process.env.PW_CHANNEL === "chromium" ? undefined : (process.env.PW_CHANNEL ?? (process.env.CI ? undefined : "chrome")),
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
