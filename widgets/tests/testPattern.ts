// TypeScript mirror of pdum.rfb.testing.render_test_pattern — the shared
// contract that lets the browser e2e verify decoded pixels locally.

export const QUADRANT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [220, 40, 40],
  [40, 200, 40],
  [40, 40, 220],
  [220, 200, 40],
];

export function expectedQuadrantColor(seq: number, quadrant: number): readonly [number, number, number] {
  const idx = (((quadrant + seq) % 4) + 4) % 4;
  return QUADRANT_COLORS[idx];
}

export interface CapturedImage {
  width: number;
  height: number;
  data: number[]; // RGBA, length width*height*4
}

/** Sample the RGB color at an interior point of the given quadrant (0..3). */
export function sampleQuadrant(img: CapturedImage, quadrant: number): [number, number, number] {
  const qx = quadrant % 2; // 0 left, 1 right
  const qy = quadrant < 2 ? 0 : 1; // 0 top, 1 bottom
  const x = Math.floor((qx + 0.5) * (img.width / 2));
  const y = Math.floor((qy + 0.5) * (img.height / 2));
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

export function channelsClose(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  tol: number,
): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tol &&
    Math.abs(a[1] - b[1]) <= tol &&
    Math.abs(a[2] - b[2]) <= tol
  );
}

/**
 * Find the rotation `k` such that every quadrant matches `QUADRANT_COLORS[(q+k)%4]`
 * within `tol`; returns `k` (0..3) or -1 if none matches.
 *
 * Any `render_test_pattern(seq)` frame is the palette cyclically rotated by `seq`
 * across the four quadrants, so a correctly decoded frame matches exactly one `k`.
 * We verify the frame's *structure* (the four distinct palette colors in the right
 * spatial cycle) rather than tying it to a specific seq: the browser-visible
 * `lastDisplayedSeq` is a per-client wire counter, not the server's render counter
 * (latest-frame-wins re-numbers per connection), so the two need not be equal.
 */
export function matchedRotation(img: CapturedImage, tol: number): number {
  for (let k = 0; k < 4; k++) {
    let ok = true;
    for (let q = 0; q < 4; q++) {
      if (!channelsClose(sampleQuadrant(img, q), QUADRANT_COLORS[(q + k) % 4], tol)) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return -1;
}
