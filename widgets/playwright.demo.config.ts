import { defineConfig, devices } from "@playwright/test";

// E2E for the `pdum-rfb demo` web app: boots the single self-contained Python process
// (uvicorn serving the prebuilt SPA + REST control plane + framebuffer WS) and drives the
// real browser UI. Separate from playwright.config.ts (which boots the 2-process simple
// demo used by the wire/protocol specs).
const PORT = 8188;

export default defineConfig({
  testDir: "packages/demo-app/tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader"] },
      },
    },
  ],
  webServer: {
    // Build the SPA into the Python package's static dir, then serve it via the demo CLI.
    command: `pnpm build:demo && cd .. && uv run pdum-rfb demo --port ${PORT} --width 320 --height 240`,
    url: `http://127.0.0.1:${PORT}/demo/capabilities`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
