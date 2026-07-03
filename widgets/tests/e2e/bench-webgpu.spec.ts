import { expect, test } from "@playwright/test";

// Draw-path benchmark, WebGPU paths. Runs ONLY in the chromium-webgpu Playwright project
// (--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader) and gates at runtime: if no adapter
// materialises the harness reports `skipped` and we skip-with-log, same posture as the other
// *-webgpu specs. Covers Mode A {webgpu} present and Mode B {webgpu} upload+composite (with a
// real GPU timestamp-query read when the adapter exposes it — SwiftShader does not, so gpuMs is
// null there and the number is wall-clock present only, NOT representative of real-GPU perf).

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
  submitMs?: Summary;
  createMs?: Summary;
  flushMs?: number;
  gpuMs?: Summary | null;
  gpuNote?: string;
}

const FRAMES = 60;
const WARMUP = 10;
const FRAME = "1280x720";

async function bench(page: import("@playwright/test").Page, query: string): Promise<BenchResult> {
  await page.goto(`/bench-harness.html?${query}&frame=${FRAME}&frames=${FRAMES}&warmup=${WARMUP}&source=videoframe`);
  await page.waitForFunction(() => !!(window as unknown as { __bench?: unknown }).__bench, undefined, {
    timeout: 90_000,
  });
  return page.evaluate(() => (window as unknown as { __bench: BenchResult }).__bench);
}

for (const { label, query } of [
  { label: "A / webgpu", query: "mode=A&surface=webgpu" },
  { label: "B / webgpu", query: "mode=B&feed=webgpu" },
] as const) {
  test(`draw-path benchmark: ${label}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const r = await bench(page, query);
    test.skip(!!r.skipped, `no WebGPU adapter (${r.reason ?? "unavailable"})`);
    expect(r.submitMs, `${label} produced no submit timings`).toBeTruthy();
    const s = r.submitMs!;
    for (const v of [s.mean, s.median, s.p95, s.min, s.max]) expect(Number.isFinite(v) && v >= 0).toBe(true);
    expect(s.n).toBe(FRAMES);
    const c = r.createMs!;
    const g = r.gpuMs ? `${r.gpuMs.mean.toFixed(3)} (n=${r.gpuMs.n})` : `null — ${r.gpuNote}`;
    const table =
      `\nDraw-path benchmark ${label} (chromium-webgpu/SwiftShader — NOT real-GPU numbers), ${FRAME}, ${FRAMES} frames, ms/frame:\n` +
      `  submit  mean=${s.mean.toFixed(3)} median=${s.median.toFixed(3)} p95=${s.p95.toFixed(3)} min=${s.min.toFixed(3)} max=${s.max.toFixed(3)}\n` +
      `  create  mean=${c.mean.toFixed(3)}\n` +
      `  flush   ${(r.flushMs ?? 0).toFixed(2)} ms (final GPU drain)\n` +
      `  gpuMs   ${g}\n`;
    // eslint-disable-next-line no-console
    console.log(table);
    await testInfo.attach(`bench-${label.replace(/\W+/g, "-")}.txt`, { body: table, contentType: "text/plain" });
  });
}
