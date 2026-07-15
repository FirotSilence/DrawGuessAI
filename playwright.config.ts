import { defineConfig, devices } from "@playwright/test";

const crossBrowserSmoke = /home is responsive|AI theatre completes|blind relay hides content/;

export default defineConfig({
  testDir: "./apps/web/tests/e2e",
  fullyParallel: false,
  timeout: 90_000,
  retries: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:43173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command:
        "pnpm --filter @drawguessai/worker exec wrangler dev --port 43174 --persist-to .wrangler/playwright-state",
      port: 43174,
      reuseExistingServer: true,
      timeout: 120_000
    },
    {
      command:
        "pnpm --filter @drawguessai/web exec vite --host 127.0.0.1 --port 43173 --strictPort",
      port: 43173,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        DRAWGUESSAI_WORKER_ORIGIN: "http://127.0.0.1:43174",
        VITE_CCSWITCH_VISION: "true",
        VITE_CCSWITCH_MAX_OBSERVATION_PASSES: "2"
      }
    }
  ],
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    },
    {
      name: "desktop-1280",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } }
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }
    },
    {
      name: "desktop-firefox",
      grep: crossBrowserSmoke,
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } }
    },
    {
      name: "desktop-webkit",
      grep: crossBrowserSmoke,
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } }
    }
  ]
});
