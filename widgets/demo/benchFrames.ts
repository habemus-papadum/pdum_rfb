// Shared deterministic moving-frame generator for the draw-path + transfer benchmarks.
//
// A rotating pool of distinct frames (a varying gradient + a moving white box + speckle) so the
// driver can't elide a redundant upload — it mirrors a real *changing* stream. Extracted so the
// main-thread harness (bench-harness.ts, DOM lib) and the bench decode worker
// (benchDecodeWorker.ts, WebWorker lib) build byte-identical frames: the transfer benchmark's
// "worker-produced vs main-produced" comparison is only apples-to-apples if both sides emit the
// same content at the same size. Every API touched here — OffscreenCanvas, VideoFrame,
// createImageBitmap, ImageBitmap — exists in BOTH global scopes.

/** A rotating pool of `n` distinct `w×h` frames (gradient + moving box + speckle). */
export function makePool(n: number, w: number, h: number): OffscreenCanvas[] {
  const pool: OffscreenCanvas[] = [];
  for (let i = 0; i < n; i++) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${(i * 37) % 360} 80% 45%)`);
    g.addColorStop(1, `hsl(${(i * 37 + 140) % 360} 80% 20%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const bw = Math.max(4, (w * 0.2) | 0);
    const bh = Math.max(4, (h * 0.2) | 0);
    const bx = ((i / n) * (w - bw)) | 0;
    ctx.fillStyle = "white";
    ctx.fillRect(bx, (h * 0.4) | 0, bw, bh);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    for (let k = 0; k < 300; k++) {
      const x = ((Math.sin(i * 1.3 + k * 2.1) * 0.5 + 0.5) * w) | 0;
      const y = ((Math.cos(i * 0.7 + k * 1.7) * 0.5 + 0.5) * h) | 0;
      ctx.fillRect(x, y, 3, 3);
    }
    pool.push(c);
  }
  return pool;
}

/** Construct one source frame from a pool canvas. `videoframe` = sync `VideoFrame`; `bitmap` =
 *  async `ImageBitmap` (the two decoder output shapes the client transfers). */
export async function makeFrame(
  src: OffscreenCanvas,
  ts: number,
  sourceKind: string,
): Promise<VideoFrame | ImageBitmap> {
  if (sourceKind === "bitmap") return createImageBitmap(src);
  return new VideoFrame(src, { timestamp: ts });
}
