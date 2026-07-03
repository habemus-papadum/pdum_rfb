import { expect, test } from "@playwright/test";

// Draw-path benchmark, driven by the server-free harness (bench-harness.html). Times the
// per-frame present cost of the display backends so the "Canvas2D default, GPU opt-in" hunch in
// docs/proposals/completed/client_display_backend.md is MEASURED. This project (chromium /
// SwiftShader) covers Mode A {2d, webgl} and Mode B {webgl}; the WebGPU paths run in the
// dedicated chromium-webgpu project (bench-webgpu.spec.ts).
//
// SwiftShader caveat: the WebGL numbers here come from a SOFTWARE rasteriser, so their absolute
// values are NOT representative of real-GPU performance — the value is the harness, the
// Canvas2D-vs-WebGL relative read, and the methodology. This spec asserts the harness runs and
// produces finite, sane timings; it does not gate on absolute speed.

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

// Modest counts keep the software-rasteriser run well within the timeout; the harness default
// (180/20 @ 1280x720) is what a human runs on real hardware.
const FRAMES = 90;
const WARMUP = 15;
const FRAME = "1280x720";

async function bench(page: import("@playwright/test").Page, query: string): Promise<BenchResult> {
  await page.goto(`/bench-harness.html?${query}&frame=${FRAME}&frames=${FRAMES}&warmup=${WARMUP}&source=videoframe`);
  await page.waitForFunction(() => !!(window as unknown as { __bench?: unknown }).__bench, undefined, {
    timeout: 90_000,
  });
  return page.evaluate(() => (window as unknown as { __bench: BenchResult }).__bench);
}

const MATRIX = [
  { label: "A / 2d", query: "mode=A&surface=2d" },
  { label: "A / webgl", query: "mode=A&surface=webgl" },
  { label: "B / webgl", query: "mode=B&feed=webgl" },
] as const;

test("draw-path benchmark: Mode A {2d,webgl} + Mode B {webgl}", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const rows: string[] = [];
  const header = `${"path".padEnd(12)}${"backend".padEnd(9)}${"submit.mean".padStart(12)}${"median".padStart(9)}${"p95".padStart(9)}${"create.mean".padStart(13)}${"flush".padStart(9)}`;
  rows.push(header);
  for (const { label, query } of MATRIX) {
    const r = await bench(page, query);
    if (r.skipped) {
      rows.push(`${label.padEnd(12)}SKIPPED (${r.reason})`);
      continue;
    }
    expect(r.submitMs, `${label} produced no submit timings`).toBeTruthy();
    const s = r.submitMs!;
    // Sanity: finite, non-negative, and monotone-ish summary. Absolute speed is NOT asserted
    // (SwiftShader), only that the measurement is real.
    for (const v of [s.mean, s.median, s.p95, s.min, s.max]) expect(Number.isFinite(v) && v >= 0).toBe(true);
    expect(s.n).toBe(FRAMES);
    const c = r.createMs!;
    const f3 = (n: number) => n.toFixed(3);
    rows.push(
      `${label.padEnd(12)}${r.backend.padEnd(9)}${f3(s.mean).padStart(12)}${f3(s.median).padStart(9)}${f3(s.p95).padStart(9)}${f3(c.mean).padStart(13)}${(r.flushMs ?? 0).toFixed(2).padStart(9)}`,
    );
  }
  const table = `\nDraw-path benchmark (chromium/SwiftShader — NOT real-GPU numbers), ${FRAME}, ${FRAMES} frames, ms/frame:\n${rows.join("\n")}\n`;
  // eslint-disable-next-line no-console
  console.log(table);
  await testInfo.attach("bench-swiftshader.txt", { body: table, contentType: "text/plain" });
});
