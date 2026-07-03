import { expect, test } from "@playwright/test";

import { type CapturedImage, matchedRotation } from "../testPattern";

const WS = "ws://127.0.0.1:8770";

// The real end-to-end pipeline on the WebGL backend: the worker builds a WebglSurface from
// the transferred OffscreenCanvas, decodes real image frames, uploads each via texImage2D,
// and presents. matchedRotation proves color + spatial structure (orientation is proven
// separately, with a controlled input, in surface-conformance.spec.ts).
test("image path decodes to the WebGL backend and reads back correct pixels", async ({ page }) => {
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image&surface=webgl`);

  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __rfb?: { stats(): { framesDisplayed: number; surface?: string } } }).__rfb;
      return !!r && r.stats().framesDisplayed > 2;
    },
    undefined,
    { timeout: 20_000 },
  );

  const surfaceKind = await page.evaluate(
    () => (window as unknown as { __rfb: { stats(): { surface?: string } } }).__rfb.stats().surface,
  );
  expect(surfaceKind, "worker should have selected the WebGL backend").toBe("webgl");

  const cap = (await page.evaluate(() =>
    (window as unknown as { __rfb: { capture(): Promise<unknown> } }).__rfb.capture(),
  )) as CapturedImage & { lastDisplayedSeq: number };

  expect(cap.width).toBeGreaterThan(0);
  expect(
    matchedRotation(cap, 24),
    `WebGL readback quadrants match no palette rotation (seq ${cap.lastDisplayedSeq})`,
  ).toBeGreaterThanOrEqual(0);
});
