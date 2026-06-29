import { expect, test } from "@playwright/test";

import { type CapturedImage, channelsClose, expectedQuadrantColor, sampleQuadrant } from "../testPattern";

const WS = "ws://127.0.0.1:8770";

// The H.264 path is gated on real WebCodecs avc1 decode support. Playwright's
// bundled Chromium usually lacks proprietary codecs, so this skips-with-log
// there; run with `channel: 'chrome'` (system Chrome) to exercise it.
test("h264 path decodes the test pattern (gated on WebCodecs avc1 support)", async ({ page }) => {
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=video`);

  const supported = await page.evaluate(async () => {
    const VD = (self as unknown as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
    if (!VD) return false;
    try {
      const r = await VD.isConfigSupported({ codec: "avc1.42E01F", codedWidth: 320, codedHeight: 240 });
      return Boolean(r.supported);
    } catch {
      return false;
    }
  });
  test.skip(!supported, "avc1.42E01F software decode unavailable in this Chromium build");

  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __rfb?: { stats(): { transport: string; framesDisplayed: number } } }).__rfb;
      return !!r && r.stats().transport === "webcodecs" && r.stats().framesDisplayed > 5;
    },
    undefined,
    { timeout: 20_000 },
  );

  const cap = (await page.evaluate(() =>
    (window as unknown as { __rfb: { capture(): Promise<unknown> } }).__rfb.capture(),
  )) as CapturedImage & { lastDisplayedSeq: number };

  for (let q = 0; q < 4; q++) {
    const actual = sampleQuadrant(cap, q);
    const expectedColor = expectedQuadrantColor(cap.lastDisplayedSeq, q);
    expect(
      channelsClose(actual, expectedColor, 30),
      `quadrant ${q} @ seq ${cap.lastDisplayedSeq}: got ${actual}, want ${expectedColor}`,
    ).toBe(true);
  }
});
