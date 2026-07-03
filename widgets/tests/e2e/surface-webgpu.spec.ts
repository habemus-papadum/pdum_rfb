import { expect, test } from "@playwright/test";

// WebGPU backend conformance. Runs ONLY in the `chromium-webgpu` Playwright project (which
// adds --enable-unsafe-webgpu --use-webgpu-adapter=swiftshader), and still gates at runtime:
// if no adapter materializes (e.g. Linux CI without Vulkan-SwiftShader), the harness falls
// back and we skip-with-log — same posture as the H.264 spec gating on isConfigSupported.
// The controlled asymmetric frame (TL red / TR green / BL blue / BR white) proves WebGPU
// orientation/scale/color, which the streaming quadrant test can't (a flip aliases to a
// palette rotation). WebGPU is also asserted pixel-equal to the Canvas2D floor at 1:1.

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

// Orientation must be right for BOTH real source types — image path (ImageBitmap) and video
// path (VideoFrame) — since their upload conventions differ (they did for WebGL/WebGPU).
for (const source of ["bitmap", "videoframe"] as const) {
  test(`webgpu (${source}): present is upright, correctly colored, and pixel-equal to canvas2d`, async ({ page }) => {
    const r = await readback(page, `surface=webgpu&source=${source}&frame=64x64&backing=64x64&fit=fill`);
    test.skip(r.kind !== "webgpu", "no WebGPU adapter in this Chromium/headless config");

    // Orientation anchor: white must be bottom-right (a flip would move it).
    expect(close(rgbAt(r, 16, 16), [255, 0, 0]), "TL red").toBe(true);
    expect(close(rgbAt(r, 48, 16), [0, 255, 0]), "TR green").toBe(true);
    expect(close(rgbAt(r, 16, 48), [0, 0, 255]), "BL blue").toBe(true);
    expect(close(rgbAt(r, 48, 48), [255, 255, 255]), "BR white").toBe(true);

    const ref = await readback(page, `surface=2d&source=${source}&frame=64x64&backing=64x64&fit=fill`);
    let maxDiff = 0;
    for (let i = 0; i < ref.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ref.data[i] - r.data[i]));
    expect(maxDiff, "WebGPU differs from Canvas2D at 1:1").toBeLessThanOrEqual(4);
  });
}

test("webgpu: contain letterboxes with the background fill", async ({ page }) => {
  const r = await readback(page, `surface=webgpu&frame=64x32&backing=64x64&fit=contain&bg=%23123456`);
  test.skip(r.kind !== "webgpu", "no WebGPU adapter in this Chromium/headless config");
  expect(close(rgbAt(r, 32, 4), [0x12, 0x34, 0x56]), "top bar is background").toBe(true);
  expect(close(rgbAt(r, 32, 60), [0x12, 0x34, 0x56]), "bottom bar is background").toBe(true);
  expect(close(rgbAt(r, 16, 24), [255, 0, 0]), "TL red").toBe(true);
  expect(close(rgbAt(r, 48, 40), [255, 255, 255]), "BR white").toBe(true);
});
