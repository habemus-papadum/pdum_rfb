import { expect, test } from "@playwright/test";

// Drives the real `pdum-rfb demo` web app in a browser: the SPA loads, the viewer
// negotiates + streams, scene/backend switches ride REST and land on the server, the
// debug toggle lights up the console, and unavailable backends are greyed out.

interface StreamState {
  name: string;
  scene: string;
  backend: string;
}

async function serverState(request: import("@playwright/test").APIRequestContext, name = "default"): Promise<StreamState> {
  const streams: StreamState[] = (await (await request.get("/demo/state")).json()).streams;
  return streams.find((s) => s.name === name)!;
}

test("SPA loads and the viewer goes live", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".demo__title")).toContainText("pdum");
  // The connection pill reads "live" once negotiated (statusLabel of "negotiated").
  await expect(page.locator(".pill")).toHaveText("live", { timeout: 20_000 });
  // A frame was decoded to the viewport canvas.
  await expect(page.locator(".viewport canvas")).toBeVisible();
});

test("scene + backend switches ride REST to the server", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator(".pill")).toHaveText("live", { timeout: 20_000 });

  await page.locator("[data-testid=scene]").selectOption("plasma");
  await expect.poll(async () => (await serverState(request)).scene, { timeout: 10_000 }).toBe("plasma");

  await page.locator("[data-testid=backend]").selectOption("image:png");
  await expect.poll(async () => (await serverState(request)).backend, { timeout: 10_000 }).toBe("image:png");
});

test("unavailable backends are greyed out", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".pill")).toHaveText("live", { timeout: 20_000 });
  // image modes are always enabled; the NVENC backends can't run on this box → disabled.
  await expect(page.locator("[data-testid=backend] option[value='image:jpeg']")).toBeEnabled();
  await expect(page.locator("[data-testid=backend] option[value='nvenc_gpu_pdum']")).toBeDisabled();
});

test("debug toggle lights up the console play-by-play", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("[rfb:")) logs.push(m.text());
  });
  await page.goto("/");
  await expect(page.locator(".pill")).toHaveText("live", { timeout: 20_000 });

  await page.locator("[data-testid=debug]").check(); // remounts the viewer with debug on
  await expect.poll(() => logs.some((l) => l.includes("[rfb:worker] config")), { timeout: 15_000 }).toBe(true);
});
