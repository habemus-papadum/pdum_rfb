import { expect, test } from "@playwright/test";

import { type CapturedImage, matchedRotation } from "../testPattern";

// Regression guard for the marimo blank-viewer bug (docs/proposals/active/marimo_rendering_fix.md).
//
// The bug: with the OffscreenCanvas-transfer path (Mode A), the worker decodes + draws frames
// correctly, but inside a host that reparents the widget subtree (marimo) the on-screen DOM
// canvas stays black — the pixels never reach the compositor. The old e2e only read back the
// WORKER surface (via capture()), so it was blind to this exact failure (§7.5).
//
// The fix: the anywidget defaults to the MAIN-THREAD present path (MainThreadPresentView) — a
// normal <canvas> drawn on the main thread from frames the worker transfers. These specs assert
// on the on-screen main-thread canvas itself (getImageData), the composited-surface ground truth.

const WS = "ws://127.0.0.1:8770/default";

test("main-thread present path paints the on-screen canvas with the streamed pattern", async ({ page }) => {
  await page.goto(`/anywidget-harness.html?ws=${encodeURIComponent(WS)}&transport=image&present=main`);

  await expect
    .poll(() => page.evaluate(() => (window as any).__rfb.state()), { timeout: 15_000 })
    .toMatch(/open|negotiated/);
  await expect
    .poll(() => page.evaluate(() => (window as any).__rfb.stats()?.framesDisplayed ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // The decisive check the old spec lacked: read the ON-SCREEN main-thread canvas back and confirm
  // it holds the four-quadrant test pattern (not a black surface). matchedRotation verifies the
  // palette is present in the right spatial cycle.
  await expect
    .poll(
      async () => {
        const cap = await page.evaluate(() => (window as any).__rfb.mainCanvasCapture());
        return cap ? matchedRotation(cap as CapturedImage, 40) : -1;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(0);
});

test("main-thread present survives the widget subtree being reparented (the marimo failure mode)", async ({ page }) => {
  await page.goto(`/anywidget-harness.html?ws=${encodeURIComponent(WS)}&transport=image&present=main`);

  await expect
    .poll(() => page.evaluate(() => (window as any).__rfb.stats()?.framesDisplayed ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // Detach + re-attach the widget subtree — the reparent that blanks an OffscreenCanvas placeholder.
  await page.evaluate(() => (window as any).__rfb.reparent());

  // After reparenting, the main-thread canvas must STILL receive + show frames (the whole point of
  // the main-thread path: no transferred placeholder to sever).
  await expect
    .poll(
      async () => {
        const cap = await page.evaluate(() => (window as any).__rfb.mainCanvasCapture());
        return cap ? matchedRotation(cap as CapturedImage, 40) : -1;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(0);
});

test("the OffscreenCanvas-transfer path (present=offscreen) still streams but is unreadable from main", async ({
  page,
}) => {
  await page.goto(`/anywidget-harness.html?ws=${encodeURIComponent(WS)}&transport=image&present=offscreen`);

  // Mode A still connects + decodes (framesDisplayed climbs via the worker).
  await expect
    .poll(() => page.evaluate(() => (window as any).__rfb.stats()?.framesDisplayed ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // …but its canvas is transferred to the worker, so a main-thread readback is impossible — which
  // is exactly why capture()-readback e2e couldn't see the marimo compositing failure (§7.5).
  const cap = await page.evaluate(() => (window as any).__rfb.mainCanvasCapture());
  expect(cap).toBeNull();
});
