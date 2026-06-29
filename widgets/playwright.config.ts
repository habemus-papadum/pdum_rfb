import { defineConfig, devices } from "@playwright/test";

const WS_PORT = 8770;
const PREVIEW_PORT = 4317;

// Headless e2e: Playwright boots BOTH the Python test server (streaming a
// deterministic synthetic pattern with the HTTP side channel for recorded
// events) and a production build of the demo page served by `vite preview`.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--use-gl=angle", "--use-angle=swiftshader"],
        },
      },
    },
  ],
  webServer: [
    {
      command: `uv run python -m pdum.rfb.server --test-pattern --record-events --host 127.0.0.1 --port ${WS_PORT}`,
      url: `http://127.0.0.1:${WS_PORT}/health`,
      cwd: "..",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm run demo:build && pnpm run demo:preview`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
