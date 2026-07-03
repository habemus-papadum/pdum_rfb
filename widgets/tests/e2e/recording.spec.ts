import { expect, test } from "@playwright/test";

// Client-side (browser) recording end-to-end: drive startRecording() → stopRecording() on a
// MainThreadPresentView (the path that owns a real on-screen <canvas>) and assert a non-empty
// video Blob comes back. Gated on MediaRecorder + a supported WebM/MP4 container so it skips
// cleanly on browser builds without canvas recording. See widgets/demo/record-harness.ts.

const WS = "ws://127.0.0.1:8770/default";

test("startRecording→stopRecording yields a non-empty video Blob (main-thread present canvas)", async ({ page }) => {
  await page.goto(`/record-harness.html?ws=${encodeURIComponent(WS)}&transport=image`);

  const supported = await page.evaluate(
    () =>
      typeof MediaRecorder !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function" &&
      (MediaRecorder.isTypeSupported("video/webm") || MediaRecorder.isTypeSupported("video/mp4")),
  );
  test.skip(!supported, "MediaRecorder / canvas recording unsupported in this browser build");

  // The view must own a recordable canvas, and frames must be painting so the stream has content.
  expect(await page.evaluate(() => (window as unknown as { __rec: any }).__rec.canRecord())).toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __rec: any }).__rec.frames()), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await page.evaluate(() => (window as unknown as { __rec: any }).__rec.start({ frameRate: 30 }));
  expect(await page.evaluate(() => (window as unknown as { __rec: any }).__rec.isRecording())).toBe(true);

  // Let ~1s of frames accumulate into the recording.
  await page.waitForTimeout(1200);

  const result = await page.evaluate(() => (window as unknown as { __rec: any }).__rec.stop());
  expect(result.type).toMatch(/^video\//);
  expect(result.size).toBeGreaterThan(0);

  // After stop, the session is done and no new recording is active.
  expect(await page.evaluate(() => (window as unknown as { __rec: any }).__rec.isRecording())).toBe(false);
});
