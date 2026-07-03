import { expect, test } from "@playwright/test";

// Viewport transform (roadmap item 1) on the WebGPU backend — proves the SAME `{src,dst}`
// geometry zoom/pan produces is clipped correctly by WebGPU's clip-space quad (not setViewport,
// so an over-large dst doesn't trip the viewport-bounds check). Runs only in the
// `chromium-webgpu` project and skips at runtime if no adapter, mirroring surface-webgpu.spec.ts.

interface Readback {
  kind: string;
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

test("webgpu: zoom 2 about center magnifies the top-left quadrant to fill", async ({ page }) => {
  const r = await readback(page, `surface=webgpu&frame=64x64&backing=64x64&fit=fill&zoom=2&panx=32&pany=32`);
  test.skip(r.kind !== "webgpu", "no WebGPU adapter in this Chromium/headless config");
  for (const [x, y] of [
    [8, 8],
    [56, 56],
    [32, 32],
  ] as const) {
    expect(close(rgbAt(r, x, y), [255, 0, 0]), `zoomed TL quadrant should be red at (${x},${y})`).toBe(true);
  }
});

test("webgpu: pan shifts the frame, revealing the background", async ({ page }) => {
  const r = await readback(page, `surface=webgpu&frame=64x64&backing=64x64&fit=fill&panx=32&pany=0&bg=%23123456`);
  test.skip(r.kind !== "webgpu", "no WebGPU adapter in this Chromium/headless config");
  expect(close(rgbAt(r, 8, 16), [0x12, 0x34, 0x56]), "left half is the background fill").toBe(true);
  expect(close(rgbAt(r, 48, 16), [255, 0, 0]), "right half top shows the frame's TL red").toBe(true);
  expect(close(rgbAt(r, 48, 48), [0, 0, 255]), "right half bottom shows the frame's BL blue").toBe(true);
});
