// The single source of truth for frame <-> canvas geometry. Pure, DOM-free, and
// unit-tested: BOTH the renderer (drawing) and the event path (click mapping) go
// through here, so a click is always accurate under any fit, zoom, or pan — the
// invariant the original HiDPI bug violated.
//
// Everything is in DEVICE pixels: `backing*` is the canvas backing store (CSS x
// client DPR, honoring the maxBackingDimension cap), `frame*` is the decoded
// frame's coded/display size. The frame's render DPR (`pixel_ratio`) does NOT
// enter here: for fill/contain/cover it scales frame and backing symmetrically
// and cancels, so it only rides on events as an echo for the publisher.
//
// The viewport transform (roadmap item 1) layers a uniform `zoom` and a `panX`/`panY`
// (backing-px) offset on top of the fit scale. `zoom = 1`, `panX = panY = 0` is exactly
// the fit-only behavior, so an omitted transform is the classic letterbox/cover/fill. It
// is expressed as an over-large destination rect (a whole-frame `src`, a `dst` that can
// exceed the canvas), the SAME convention `cover` already uses to show a cropped sub-rect
// — every backend clips the overflow (Canvas2D drawImage, GL viewport, WebGPU clip-space),
// so zoom/pan need no new draw code.

export type FitMode = "fill" | "contain" | "cover";

export interface ViewportState {
  /** Decoded frame size (device px). */
  frameW: number;
  frameH: number;
  /** Canvas backing-store size (device px). */
  backingW: number;
  backingH: number;
  fit: FitMode;
  /** Uniform zoom multiplier on top of the fit scale (1 = fit, >1 = zoomed in). Omit
   *  for identity. */
  zoom?: number;
  /** Pan offset of the drawn frame in backing (device) px; positive moves it right/down.
   *  Omit for centered. */
  panX?: number;
  panY?: number;
}

/** The mutable viewport transform carried by the view / worker / chrome: a uniform zoom
 *  plus a backing-px pan. `presentGeometry`/`backingToFrame` read it off a `ViewportState`. */
export interface ViewportTransform {
  zoom: number;
  panX: number;
  panY: number;
}

/** A fit mode plus the zoom/pan transform — the full framing the view holds and posts to
 *  the worker. */
export interface ViewportFraming extends ViewportTransform {
  fit: FitMode;
}

/** Named presets on top of the general transform. `fit`/`cover`/`fill` reset to that fit
 *  mode at zoom 1; `one-to-one` shows the frame at native device-pixel scale (1 frame px =
 *  1 backing px), centered. */
export type ViewPreset = "fit" | "cover" | "fill" | "one-to-one";

export const IDENTITY_TRANSFORM: ViewportTransform = { zoom: 1, panX: 0, panY: 0 };
export const DEFAULT_MIN_ZOOM = 0.05;
export const DEFAULT_MAX_ZOOM = 64;

export interface DestRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** A rectangle in some pixel space: frame px for a source rect, backing px for a
 *  destination rect. The `{x,y,w,h}` shape both `src` and `dst` share in a
 *  `PresentGeometry`. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole composite primitive a display backend draws: sample `src` (a region of
 *  the current frame, frame px) into `dst` (a region of the backing store, backing
 *  px). It subsumes fit (whole-frame `src`) AND zoom/pan/crop (an over-large `dst`
 *  the backend clips). Every backend — Canvas2D `drawImage`, a WebGL textured quad, a
 *  WebGPU sampled quad — can execute it. */
export interface PresentGeometry {
  src: Rect;
  dst: Rect;
}

/** Per-axis scale factors (frame device px -> backing device px) for the fit mode ALONE
 *  (no zoom). */
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

/** Per-axis scale factors including the zoom multiplier (the effective frame->backing
 *  scale actually drawn). */
export function effectiveScales(v: ViewportState): { scaleX: number; scaleY: number } {
  const { scaleX, scaleY } = fitScales(v);
  const zoom = v.zoom ?? 1;
  return { scaleX: scaleX * zoom, scaleY: scaleY * zoom };
}

/**
 * Where the frame is drawn inside the backing store (device px), under fit + zoom + pan.
 * For `cover` (or any zoom > 1) the rect exceeds the canvas and is clipped by the draw;
 * for `contain` at zoom 1 it is centered and letterboxed; for `fill` at zoom 1 it is the
 * whole canvas. Pan translates the centered rect; zoom scales it about the canvas center.
 */
export function frameDestRect(v: ViewportState): DestRect {
  const { scaleX, scaleY } = effectiveScales(v);
  const dw = v.frameW * scaleX;
  const dh = v.frameH * scaleY;
  const dx = (v.backingW - dw) / 2 + (v.panX ?? 0);
  const dy = (v.backingH - dh) / 2 + (v.panY ?? 0);
  return { dx, dy, dw, dh };
}

/**
 * Inverse map: a backing-store point -> frame pixels, with an `inside` flag that is
 * false in letterbox padding (or outside a `cover`/zoom crop), so the publisher can ignore
 * or clamp out-of-frame clicks. `x`/`y` are unclamped frame pixels (may fall outside
 * `[0, frame)` when `inside` is false). Exact inverse of `frameDestRect`, so it round-trips
 * under any fit/zoom/pan.
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

/**
 * The `{ src, dst }` a display backend draws for this fit/zoom/pan state. `src` is always
 * the whole frame and `dst` is `frameDestRect` (which may exceed the canvas under
 * `cover`/zoom — the backend clips it). `backingToFrame` is its exact inverse, so a click
 * maps through whatever zoom/pan is current and stays accurate.
 */
export function presentGeometry(v: ViewportState): PresentGeometry {
  const { dx, dy, dw, dh } = frameDestRect(v);
  return {
    src: { x: 0, y: 0, w: v.frameW, h: v.frameH },
    dst: { x: dx, y: dy, w: dw, h: dh },
  };
}

// --- transform helpers (presets + gestures) --------------------------------
// Pure math the view / chrome / worker share: gestures and preset buttons only mutate a
// ViewportTransform through these, then the present loop redraws the retained frame (no
// wire change).

/** Clamp a zoom into `[min, max]` (defaults 0.05..64). */
export function clampZoom(zoom: number, min = DEFAULT_MIN_ZOOM, max = DEFAULT_MAX_ZOOM): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(max, Math.max(min, zoom));
}

/** Read the current transform off a state (filling identity defaults). */
export function transformOf(v: ViewportState): ViewportTransform {
  return { zoom: v.zoom ?? 1, panX: v.panX ?? 0, panY: v.panY ?? 0 };
}

/**
 * Set zoom while keeping the frame point currently under the backing point `(bx, by)`
 * anchored there — the "zoom toward the cursor" gesture. Returns the new transform (zoom
 * already clamped).
 */
export function zoomAround(v: ViewportState, newZoom: number, bx: number, by: number): ViewportTransform {
  const zoom = clampZoom(newZoom);
  const { x: fx, y: fy } = backingToFrame(v, bx, by); // frame point under the cursor now
  const { scaleX, scaleY } = fitScales(v); // fit scale WITHOUT zoom
  const sx = scaleX * zoom;
  const sy = scaleY * zoom;
  // Solve b = backing/2 + pan + s*(f - frame/2) for pan, so (fx,fy) stays under (bx,by).
  const panX = bx - v.backingW / 2 - sx * (fx - v.frameW / 2);
  const panY = by - v.backingH / 2 - sy * (fy - v.frameH / 2);
  return { zoom, panX, panY };
}

/** Translate the current pan by a backing-px delta (drag-pan). */
export function panByBacking(v: ViewportState, dxBacking: number, dyBacking: number): ViewportTransform {
  return { zoom: v.zoom ?? 1, panX: (v.panX ?? 0) + dxBacking, panY: (v.panY ?? 0) + dyBacking };
}

/** Center the frame point `(frameX, frameY)` in the canvas at the current zoom. */
export function centerOnFrame(v: ViewportState, frameX: number, frameY: number): ViewportTransform {
  const { scaleX, scaleY } = effectiveScales(v);
  return {
    zoom: v.zoom ?? 1,
    panX: scaleX * (v.frameW / 2 - frameX),
    panY: scaleY * (v.frameH / 2 - frameY),
  };
}

/**
 * Resolve a named preset into a full framing (fit + transform). `fit`/`cover`/`fill` reset
 * to that fit at zoom 1, centered. `one-to-one` shows the frame at native device-pixel
 * scale (effective scale 1) using a uniform `contain` base, centered.
 */
export function presetFraming(v: ViewportState, preset: ViewPreset): ViewportFraming {
  switch (preset) {
    case "cover":
      return { fit: "cover", ...IDENTITY_TRANSFORM };
    case "fill":
      return { fit: "fill", ...IDENTITY_TRANSFORM };
    case "one-to-one": {
      // Uniform 1:1: pick contain (so scaleX==scaleY) and cancel it, giving effective scale 1.
      const base = fitScales({ ...v, fit: "contain" }).scaleX;
      const zoom = base > 0 ? clampZoom(1 / base) : 1;
      return { fit: "contain", zoom, panX: 0, panY: 0 };
    }
    default: // "fit"
      return { fit: "contain", ...IDENTITY_TRANSFORM };
  }
}
