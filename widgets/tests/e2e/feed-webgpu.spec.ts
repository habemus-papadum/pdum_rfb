import { expect, test } from "@playwright/test";

// Mode B (frame-as-texture) conformance on WebGPU: the CALLER receives the frame in its own
// WebGPU device (via FrameTextureFeed's uploader, sampled here from currentTexture()) and
// composites it. Runs in the chromium-webgpu project; gates + skips if no adapter. A
// controlled asymmetric frame proves orientation/color for both real source types.

interface Readback {
  kind: string;
  width: number;
  height: number;
  data: number[];
}

async function readback(page: import("@playwright/test").Page, query: string): Promise<Readback> {
  await page.goto(`/feed-harness.html?${query}`);
  await page.waitForFunction(() => !!(window as unknown as { __feed?: unknown }).__feed, undefined, {
    timeout: 10_000,
  });
  return page.evaluate(() => (window as unknown as { __feed: Readback }).__feed);
}

function rgbAt(r: Readback, x: number, y: number): [number, number, number] {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
}
function close(a: readonly number[], b: readonly number[], tol = 6): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

for (const source of ["bitmap", "videoframe"] as const) {
  test(`feed=webgpu (${source}): caller composites the frame texture upright`, async ({ page }) => {
    const r = await readback(page, `feed=webgpu&source=${source}&frame=64x64`);
    test.skip(r.kind !== "webgpu", "no WebGPU adapter in this Chromium/headless config");
    expect(close(rgbAt(r, 16, 16), [255, 0, 0]), "TL red").toBe(true);
    expect(close(rgbAt(r, 48, 16), [0, 255, 0]), "TR green").toBe(true);
    expect(close(rgbAt(r, 16, 48), [0, 0, 255]), "BL blue").toBe(true);
    expect(close(rgbAt(r, 48, 48), [255, 255, 255]), "BR white").toBe(true);
  });
}
