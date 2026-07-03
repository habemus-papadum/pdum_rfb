import { expect, test } from "@playwright/test";

// Viewport transform (roadmap item 1) present-correctness, driven by the server-free surface
// harness with a controlled asymmetric frame (TL red / TR green / BL blue / BR white). Proves
// zoom (about the canvas center) magnifies the right sub-region and pan translates it, on BOTH
// the Canvas2D floor and the WebGL2 backend — the same `{src,dst}` geometry each backend clips.

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

function close(a: readonly number[], b: readonly number[], tol = 8): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

for (const surface of ["2d", "webgl"] as const) {
  test(`surface=${surface}: zoom 2 about center magnifies the top-left quadrant to fill`, async ({ page }) => {
    // 64x64 frame into 64x64 canvas, fill, zoom 2, pan (32,32): the dst becomes 128x128 at
    // origin, so the visible canvas samples frame x/y in [0,32) — the whole red TL quadrant.
    const r = await readback(page, `surface=${surface}&frame=64x64&backing=64x64&fit=fill&zoom=2&panx=32&pany=32`);
    expect(r.kind, `requested ${surface} but got ${r.kind}`).toBe(surface);
    for (const [x, y] of [
      [8, 8],
      [56, 8],
      [8, 56],
      [56, 56],
      [32, 32],
    ] as const) {
      expect(close(rgbAt(r, x, y), [255, 0, 0]), `zoomed TL quadrant should be red at (${x},${y})`).toBe(true);
    }
  });

  test(`surface=${surface}: pan shifts the frame, revealing the background`, async ({ page }) => {
    // fill, zoom 1, pan x +32: the frame slides right by half the canvas — the left half is the
    // background fill, the right half shows the frame's LEFT column (red over blue).
    const r = await readback(page, `surface=${surface}&frame=64x64&backing=64x64&fit=fill&panx=32&pany=0&bg=%23123456`);
    expect(r.kind).toBe(surface);
    expect(close(rgbAt(r, 8, 16), [0x12, 0x34, 0x56]), "left half is the background fill").toBe(true);
    expect(close(rgbAt(r, 8, 48), [0x12, 0x34, 0x56]), "left half is the background fill").toBe(true);
    expect(close(rgbAt(r, 48, 16), [255, 0, 0]), "right half top shows the frame's TL red").toBe(true);
    expect(close(rgbAt(r, 48, 48), [0, 0, 255]), "right half bottom shows the frame's BL blue").toBe(true);
  });
}
