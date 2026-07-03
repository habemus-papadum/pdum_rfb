import { expect, test } from "@playwright/test";

import { type CapturedImage, matchedRotation } from "../testPattern";

const WS = "ws://127.0.0.1:8770";

// Mode B end-to-end: FrameTextureFeed runs a decode worker in feed mode (WS + decoder),
// TRANSFERS each decoded frame to the main thread, and uploads it into the caller's WebGL2
// texture; the harness (the caller) composites that texture and reads it back. matchedRotation
// proves the whole worker→transfer→upload→sample pipeline delivers correct pixels.
test("FrameTextureFeed streams decoded frames into the caller's WebGL texture", async ({ page }) => {
  await page.goto(`/feed-harness.html?feed=webgl&ws=${encodeURIComponent(WS)}`);

  // The harness republishes __feed on every uploaded frame; wait for a populated one.
  await page.waitForFunction(
    () => {
      const f = (window as unknown as { __feed?: { width: number } }).__feed;
      return !!f && f.width > 0;
    },
    undefined,
    { timeout: 20_000 },
  );

  const cap = (await page.evaluate(() => (window as unknown as { __feed: CapturedImage }).__feed)) as CapturedImage;
  expect(cap.width).toBeGreaterThan(0);
  expect(
    matchedRotation(cap, 24),
    "Mode B WebGL readback quadrants match no palette rotation",
  ).toBeGreaterThanOrEqual(0);
});
