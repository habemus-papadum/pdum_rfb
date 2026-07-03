import { expect, test } from "@playwright/test";

import { type CapturedImage, matchedRotation } from "../testPattern";

const WS = "ws://127.0.0.1:8770";

// The batteries backend-switch: RemoteFramebufferView.setSurface() tears down the worker/canvas
// (a canvas context type is immutable) and rebuilds with the new draw path, reconnecting the
// stream. This proves the live switch works end-to-end — the stream still decodes to correct
// pixels on the NEW backend, and stats.surface reports it.

interface RfbHook {
  state(): string;
  stats(): { framesDisplayed: number; surface?: string };
  surface(): string | undefined;
  setSurface(kind: string): void;
  capture(): Promise<CapturedImage & { lastDisplayedSeq: number }>;
}

function hook(page: import("@playwright/test").Page) {
  return {
    waitFrames: (n: number) =>
      page.waitForFunction(
        (min) => {
          const r = (window as unknown as { __rfb?: RfbHook }).__rfb;
          return !!r && r.state() === "negotiated" && r.stats().framesDisplayed > min;
        },
        n,
        { timeout: 20_000 },
      ),
    surface: () => page.evaluate(() => (window as unknown as { __rfb: RfbHook }).__rfb.surface()),
    setSurface: (kind: string) =>
      page.evaluate((k) => (window as unknown as { __rfb: RfbHook }).__rfb.setSurface(k), kind),
    capture: () => page.evaluate(() => (window as unknown as { __rfb: RfbHook }).__rfb.capture()),
  };
}

test("live switch from Canvas2D to WebGL keeps decoding the pattern", async ({ page }) => {
  await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image&surface=2d`);
  const h = hook(page);

  await h.waitFrames(2);
  expect(await h.surface(), "starts on the Canvas2D floor").toBe("2d");
  const before = (await h.capture()) as CapturedImage & { lastDisplayedSeq: number };
  expect(matchedRotation(before, 24), "Canvas2D readback is a valid test pattern").toBeGreaterThanOrEqual(0);

  // Switch the backend — rebuilds the worker + canvas with WebGL and reconnects the stream.
  await h.setSurface("webgl");

  // The rebuild reconnects; wait for the new backend to be reported and fresh frames to land.
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __rfb?: RfbHook }).__rfb;
      return !!r && r.state() === "negotiated" && r.stats().surface === "webgl" && r.stats().framesDisplayed > 2;
    },
    undefined,
    { timeout: 20_000 },
  );
  expect(await h.surface(), "now on the WebGL backend").toBe("webgl");

  const after = (await h.capture()) as CapturedImage & { lastDisplayedSeq: number };
  expect(after.width).toBeGreaterThan(0);
  expect(matchedRotation(after, 24), "WebGL readback after the switch is a valid test pattern").toBeGreaterThanOrEqual(
    0,
  );
});
