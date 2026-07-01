import { expect, test } from "@playwright/test";

// Drives the real anywidget front-end module (../anywidget/entry) via a stubbed model
// against the booted Python test server — proving render() connects, decodes, displays,
// and reads stats back into the model, with no Jupyter in the loop.
test("anywidget widget connects, streams frames, and reads stats back into the model", async ({ page }) => {
  await page.goto("/anywidget-harness.html?ws=ws://127.0.0.1:8770/default&transport=image");

  // render() created the surface + canvas.
  await expect.poll(() => page.evaluate(() => (window as any).__rfb.hasCanvas())).toBe(true);

  // Connection negotiated.
  await expect
    .poll(() => page.evaluate(() => (window as any).__rfb.state()), { timeout: 15_000 })
    .toMatch(/open|negotiated/);

  // Frames flowing → stats read back into the model trait (the ~1 Hz JS→Python push).
  await expect
    .poll(() => page.evaluate(() => (window as any).__rfb.stats()?.framesDisplayed ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // No error surfaced.
  expect(await page.evaluate(() => (window as any).__rfb.lastError())).toBe("");
});
