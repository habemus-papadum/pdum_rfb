import { expect, test } from "@playwright/test";

// Backend conformance, driven by the server-free harness (surface-harness.html). A
// controlled asymmetric frame (TL red / TR green / BL blue / BR white) proves each backend
// gets orientation, scaling, letterbox, and color right — the streaming quadrant test
// (image/video-path specs) can't catch a vertical flip because a flip aliases to a palette
// rotation. WebGL is also asserted pixel-equal to the Canvas2D floor at 1:1.

interface Readback {
  kind: string;
  requested: string;
  width: number;
  height: number;
  data: number[];
}

async function readback(page: import("@playwright/test").Page, query: string): Promise<Readback> {
  await page.goto(`/surface-harness.html?${query}`);
  await page.waitForFunction(() => !!(window as unknown as { __surface?: unknown }).__surface, undefined, {
    timeout: 10_000,
  });
  return page.evaluate(() => (window as unknown as { __surface: Readback }).__surface);
}

function rgbAt(r: Readback, x: number, y: number): [number, number, number] {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
}

function close(a: readonly number[], b: readonly number[], tol = 6): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

for (const surface of ["2d", "webgl"] as const) {
  // Orientation must hold for BOTH real source types — image path (ImageBitmap) and video
  // path (VideoFrame). Their upload conventions differ, so both are checked.
  for (const source of ["bitmap", "videoframe"] as const) {
    test(`surface=${surface} (${source}): 1:1 present is upright and correctly colored`, async ({ page }) => {
      const r = await readback(page, `surface=${surface}&source=${source}&frame=64x64&backing=64x64&fit=fill`);
      expect(r.kind, `requested ${surface} but got ${r.kind} (backend unavailable?)`).toBe(surface);
      // The white BR corner is the orientation anchor: a vertical flip would put white
      // top-right, a horizontal flip bottom-left, a transpose top-right.
      expect(close(rgbAt(r, 16, 16), [255, 0, 0]), "TL should be red").toBe(true);
      expect(close(rgbAt(r, 48, 16), [0, 255, 0]), "TR should be green").toBe(true);
      expect(close(rgbAt(r, 16, 48), [0, 0, 255]), "BL should be blue").toBe(true);
      expect(close(rgbAt(r, 48, 48), [255, 255, 255]), "BR should be white").toBe(true);
    });
  }

  test(`surface=${surface}: contain letterboxes with the background fill`, async ({ page }) => {
    // 64x32 frame (2:1) into a 64x64 canvas, contain -> image on rows 16..48, bars elsewhere.
    const r = await readback(page, `surface=${surface}&frame=64x32&backing=64x64&fit=contain&bg=%23123456`);
    expect(r.kind).toBe(surface);
    expect(close(rgbAt(r, 32, 4), [0x12, 0x34, 0x56]), "top bar is background").toBe(true);
    expect(close(rgbAt(r, 32, 60), [0x12, 0x34, 0x56]), "bottom bar is background").toBe(true);
    // Displayed image quadrant centers (image spans y 16..48).
    expect(close(rgbAt(r, 16, 24), [255, 0, 0]), "TL red").toBe(true);
    expect(close(rgbAt(r, 48, 24), [0, 255, 0]), "TR green").toBe(true);
    expect(close(rgbAt(r, 16, 40), [0, 0, 255]), "BL blue").toBe(true);
    expect(close(rgbAt(r, 48, 40), [255, 255, 255]), "BR white").toBe(true);
  });
}

test("webgl is pixel-equal to canvas2d at 1:1 (same controlled input)", async ({ page }) => {
  const a = await readback(page, `surface=2d&frame=64x64&backing=64x64&fit=fill`);
  const b = await readback(page, `surface=webgl&frame=64x64&backing=64x64&fit=fill`);
  expect(b.kind).toBe("webgl");
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  let maxDiff = 0;
  for (let i = 0; i < a.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i]));
  // At 1:1 both do a straight copy; allow only rounding noise.
  expect(maxDiff, "WebGL and Canvas2D differ at 1:1").toBeLessThanOrEqual(4);
});
