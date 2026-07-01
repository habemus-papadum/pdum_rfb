// The single source of truth for frame <-> canvas geometry. Pure, DOM-free, and
// unit-tested: BOTH the renderer (drawing) and the event path (click mapping) go
// through here, so a click is always accurate under any fit — the invariant the
// original HiDPI bug violated.
//
// Everything is in DEVICE pixels: `backing*` is the canvas backing store (CSS x
// client DPR, honoring the maxBackingDimension cap), `frame*` is the decoded
// frame's coded/display size. The frame's render DPR (`pixel_ratio`) does NOT
// enter here: for fill/contain/cover it scales frame and backing symmetrically
// and cancels, so it only rides on events as an echo for the publisher.

export type FitMode = "fill" | "contain" | "cover";

export interface ViewportState {
  /** Decoded frame size (device px). */
  frameW: number;
  frameH: number;
  /** Canvas backing-store size (device px). */
  backingW: number;
  backingH: number;
  fit: FitMode;
  // Reserved for a future zoom/pan iteration; identity (1 / 0 / 0) for now, so the
  // contract is forward-compatible without a wire change. Omit to accept identity.
  zoom?: number;
  panX?: number;
  panY?: number;
}

export interface DestRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Per-axis scale factors (frame device px -> backing device px) for the fit mode. */
export function fitScales(v: ViewportState): { scaleX: number; scaleY: number } {
  const sx = v.frameW > 0 ? v.backingW / v.frameW : 1;
  const sy = v.frameH > 0 ? v.backingH / v.frameH : 1;
  switch (v.fit) {
    case "contain": {
      const s = Math.min(sx, sy);
      return { scaleX: s, scaleY: s };
    }
    case "cover": {
      const s = Math.max(sx, sy);
      return { scaleX: s, scaleY: s };
    }
    default: // "fill": stretch each axis independently (the pre-fit-modes behavior)
      return { scaleX: sx, scaleY: sy };
  }
}

/**
 * Where the frame is drawn inside the backing store (device px). For `cover` the
 * rect exceeds the canvas and is clipped by the draw; for `contain` it is centered
 * and letterboxed; for `fill` it is the whole canvas.
 */
export function frameDestRect(v: ViewportState): DestRect {
  const { scaleX, scaleY } = fitScales(v);
  const dw = v.frameW * scaleX;
  const dh = v.frameH * scaleY;
  const dx = (v.backingW - dw) / 2;
  const dy = (v.backingH - dh) / 2;
  return { dx, dy, dw, dh };
}

/**
 * Inverse map: a backing-store point -> frame pixels, with an `inside` flag that is
 * false in letterbox padding (or outside a `cover` crop), so the publisher can ignore
 * or clamp out-of-frame clicks. `x`/`y` are unclamped frame pixels (may fall outside
 * `[0, frame)` when `inside` is false).
 */
export function backingToFrame(
  v: ViewportState,
  bx: number,
  by: number,
): { x: number; y: number; inside: boolean } {
  const { dx, dy, dw, dh } = frameDestRect(v);
  const x = dw > 0 ? ((bx - dx) / dw) * v.frameW : 0;
  const y = dh > 0 ? ((by - dy) / dh) * v.frameH : 0;
  const inside = x >= 0 && x < v.frameW && y >= 0 && y < v.frameH;
  return { x, y, inside };
}
