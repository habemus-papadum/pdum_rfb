import { expect, test } from "@playwright/test";

// Transfer benchmark, WebGPU caller. Runs ONLY in the chromium-webgpu Playwright project
// (--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader) and gates at runtime: if no adapter
// materialises the harness reports `skipped` and we skip-with-log, same posture as the other
// *-webgpu specs. Drives mode=transfer with feed=webgpu — a decode worker (benchDecodeWorker.ts)
// transfers each frame to main, main uploads it into a WebgpuFrameTexture
// (copyExternalImageToTexture) — reporting the postMessage(Transferable) handoff + the upload,
// against an off-main baseline. See bench-transfer.spec.ts for the webgl caller and the full
// SwiftShader + timer-coarsening caveat (both apply here unchanged: absolutes are software-
// rasteriser + coarsened; read transferMs as an aggregate ceiling, real numbers need a
// cross-origin-isolated hardware run).

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

const FRAMES = 40;
const WARMUP = 10;
const FRAME = "1280x720";

async function bench(page: import("@playwright/test").Page, query: string): Promise<BenchResult> {
  await page.goto(`/bench-harness.html?${query}&frame=${FRAME}&frames=${FRAMES}&warmup=${WARMUP}`);
  await page.waitForFunction(() => !!(window as unknown as { __bench?: unknown }).__bench, undefined, {
    timeout: 90_000,
  });
  return page.evaluate(() => (window as unknown as { __bench: BenchResult }).__bench);
}

test("transfer benchmark: worker→main handoff + upload (webgpu caller)", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const r = await bench(page, "mode=transfer&feed=webgpu&source=videoframe");
  test.skip(!!r.skipped, `no WebGPU adapter (${r.reason ?? "unavailable"})`);

  for (const key of ["transferMs", "uploadMs", "baselineUploadMs", "createMs"] as const) {
    const s = r[key];
    expect(s, `${key} missing`).toBeTruthy();
    for (const v of [s!.mean, s!.median, s!.p95, s!.min, s!.max]) {
      expect(Number.isFinite(v) && v >= 0, `${key} not finite/nonneg`).toBe(true);
    }
  }
  expect(r.transferMs!.min).toBeGreaterThanOrEqual(0);
  expect(r.transferMs!.n).toBe(FRAMES);
  expect(r.uploadMs!.n).toBe(FRAMES);
  expect(r.baselineUploadMs!.n).toBe(FRAMES);

  const f3 = (n: number) => n.toFixed(3);
  const line = (label: string, s: Summary) =>
    `  ${label.padEnd(16)} mean=${f3(s.mean)} median=${f3(s.median)} p95=${f3(s.p95)} min=${f3(s.min)} max=${f3(s.max)}`;
  const table =
    `\nTransfer benchmark (chromium-webgpu/SwiftShader — NOT real-GPU numbers; timer coarsened, COI=${r.crossOriginIsolated}), ` +
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
  await testInfo.attach("bench-transfer-webgpu.txt", { body: table, contentType: "text/plain" });
});
