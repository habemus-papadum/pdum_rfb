import { expect, test } from "@playwright/test";

import { type CapturedImage, matchedRotation, sampleQuadrant } from "../testPattern";

const WS = "ws://127.0.0.1:8770";

// The image path always works headlessly (createImageBitmap). This is the
// unconditional correctness gate: decode real frames and verify the pixels.
test("image path decodes the test pattern to the canvas", async ({ page }) => {
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image`);

  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __rfb?: { stats(): { framesDisplayed: number } } }).__rfb;
      return !!r && r.stats().framesDisplayed > 2;
    },
    undefined,
    { timeout: 20_000 },
  );

  const cap = (await page.evaluate(() =>
    (window as unknown as { __rfb: { capture(): Promise<unknown> } }).__rfb.capture(),
  )) as CapturedImage & { lastDisplayedSeq: number };

  expect(cap.width).toBeGreaterThan(0);
  expect(cap.lastDisplayedSeq).toBeGreaterThanOrEqual(0);

  // The decoded frame must be render_test_pattern(k) for some rotation k — the four
  // palette colors in the correct spatial cycle. (We don't tie k to lastDisplayedSeq:
  // the wire seq is a per-client counter, not the server's render counter.)
  const quads = [0, 1, 2, 3].map((q) => sampleQuadrant(cap, q));
  expect(
    matchedRotation(cap, 24),
    `quadrants ${JSON.stringify(quads)} (seq ${cap.lastDisplayedSeq}) match no palette rotation`,
  ).toBeGreaterThanOrEqual(0);
});
