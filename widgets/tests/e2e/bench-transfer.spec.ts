import { expect, test } from "@playwright/test";

// Transfer benchmark, WebGL caller (chromium/SwiftShader project). The other half of the
// draw-path story: the present benchmark (bench.spec.ts) showed submitting a frame is negligible
// on every backend, but Mode B (FrameTextureFeed) also pays a WORKER→MAIN frame transfer before
// the caller can upload it. This drives mode=transfer in bench-harness.ts — a decode worker
// (benchDecodeWorker.ts) builds each frame and postMessage-transfers it to main, main uploads it
// into a WebglFrameTexture — and reports the postMessage(Transferable) handoff latency + the
// main-thread upload(), against an off-main baseline (frame built ON main, no transfer). The
// WebGPU caller runs in bench-transfer-webgpu.spec.ts (the gated chromium-webgpu project).
//
// TWO caveats stack here and both are LOUD, because they bound how the numbers may be read:
//   1. SwiftShader — the headless GPU is a software rasteriser, so upload/drain absolutes are
//      NOT real-GPU numbers (same as bench.spec.ts).
//   2. Timer coarsening — the preview server is NOT cross-origin isolated, so performance.now()
//      is coarsened (~100µs) + jittered. A Transferable handoff is a handle move (sub-100µs), so
//      per-sample transferMs quantises to 0 / a coarse step; read the MEAN as an aggregate
//      ceiling. Real per-frame handoff timing needs a COOP/COEP (crossOriginIsolated) hardware
//      run. This spec asserts the harness runs and produces finite, sane, comparable timings; it
//      does not gate on absolute speed.

interface Summary {
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  n: number;
}
interface BenchResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  mode: string;
  backend: string;
  transferMs?: Summary;
  uploadMs?: Summary;
  baselineUploadMs?: Summary;
  createMs?: Summary;
  flushMs?: number;
  crossOriginIsolated?: boolean;
  gpuNote?: string;
}

// Ping-pong is a round trip per frame, so keep the count modest for the software-rasteriser run.
const FRAMES = 60;
const WARMUP = 10;
const FRAME = "1280x720";

async function bench(page: import("@playwright/test").Page, query: string): Promise<BenchResult> {
  await page.goto(`/bench-harness.html?${query}&frame=${FRAME}&frames=${FRAMES}&warmup=${WARMUP}`);
  await page.waitForFunction(() => !!(window as unknown as { __bench?: unknown }).__bench, undefined, {
    timeout: 90_000,
  });
  return page.evaluate(() => (window as unknown as { __bench: BenchResult }).__bench);
}

test("transfer benchmark: worker→main handoff + upload (webgl caller)", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const r = await bench(page, "mode=transfer&feed=webgl&source=videoframe");
  test.skip(!!r.skipped, `webgl caller unavailable (${r.reason ?? "unknown"})`);

  for (const key of ["transferMs", "uploadMs", "baselineUploadMs", "createMs"] as const) {
    const s = r[key];
    expect(s, `${key} missing`).toBeTruthy();
    for (const v of [s!.mean, s!.median, s!.p95, s!.min, s!.max]) {
      expect(Number.isFinite(v) && v >= 0, `${key} not finite/nonneg`).toBe(true);
    }
  }
  // transferMs is a one-way delta between two threads' absolute clocks; the harness clamps
  // sub-resolution negatives to 0, so the floor is a hard invariant worth asserting.
  expect(r.transferMs!.min).toBeGreaterThanOrEqual(0);
  expect(r.transferMs!.n).toBe(FRAMES);
  expect(r.uploadMs!.n).toBe(FRAMES);
  expect(r.baselineUploadMs!.n).toBe(FRAMES);

  const f3 = (n: number) => n.toFixed(3);
  const line = (label: string, s: Summary) =>
    `  ${label.padEnd(16)} mean=${f3(s.mean)} median=${f3(s.median)} p95=${f3(s.p95)} min=${f3(s.min)} max=${f3(s.max)}`;
  const table =
    `\nTransfer benchmark (chromium/SwiftShader — NOT real-GPU numbers; timer coarsened, COI=${r.crossOriginIsolated}), ` +
    `${FRAME}, ${FRAMES} frames, ms/frame:\n` +
    `  backend=${r.backend}\n` +
    `${line("transfer(→main)", r.transferMs!)}\n` +
    `${line("upload(xfer)", r.uploadMs!)}\n` +
    `${line("upload(baseline)", r.baselineUploadMs!)}\n` +
    `${line("create(worker)", r.createMs!)}\n` +
    `  ${"flush(drain)".padEnd(16)} ${(r.flushMs ?? 0).toFixed(2)} ms\n` +
    `  note: ${r.gpuNote ?? ""}\n`;
  // eslint-disable-next-line no-console
  console.log(table);
  await testInfo.attach("bench-transfer-webgl.txt", { body: table, contentType: "text/plain" });
});
