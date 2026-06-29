import { expect, test } from "@playwright/test";

import { type CapturedImage, channelsClose, expectedQuadrantColor, sampleQuadrant } from "../testPattern";

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

  for (let q = 0; q < 4; q++) {
    const actual = sampleQuadrant(cap, q);
    const expectedColor = expectedQuadrantColor(cap.lastDisplayedSeq, q);
    expect(
      channelsClose(actual, expectedColor, 24),
      `quadrant ${q} @ seq ${cap.lastDisplayedSeq}: got ${actual}, want ${expectedColor}`,
    ).toBe(true);
  }
});
