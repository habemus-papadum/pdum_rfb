import { describe, expect, it } from "vitest";

import { type CapturedImage, matchedRotation, QUADRANT_COLORS } from "../testPattern";

// Build a 2x2 CapturedImage whose quadrants are the palette rotated by `k`,
// matching render_test_pattern: quadrant q (TL,TR,BL,BR) = QUADRANT_COLORS[(q+k)%4].
function rotatedFrame(k: number, jitter = 0): CapturedImage {
  const w = 2;
  const h = 2;
  const data = new Array(w * h * 4).fill(0);
  const quadXY = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  for (let q = 0; q < 4; q++) {
    const [x, y] = quadXY[q];
    const [r, g, b] = QUADRANT_COLORS[(q + k) % 4];
    const i = (y * w + x) * 4;
    data[i] = r + jitter;
    data[i + 1] = g - jitter;
    data[i + 2] = b + jitter;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe("matchedRotation", () => {
  it("recovers each rotation exactly", () => {
    for (let k = 0; k < 4; k++) {
      expect(matchedRotation(rotatedFrame(k), 2)).toBe(k);
    }
  });

  it("tolerates lossy-decode jitter within tol", () => {
    expect(matchedRotation(rotatedFrame(2, 10), 24)).toBe(2);
  });

  it("returns -1 when no rotation matches", () => {
    const garbage: CapturedImage = { width: 2, height: 2, data: new Array(16).fill(7) };
    expect(matchedRotation(garbage, 24)).toBe(-1);
  });
});
