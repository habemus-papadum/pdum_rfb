// Picks a display backend for a canvas, honoring the caller's preference with graceful
// fallback to the Canvas2D floor. See docs/proposals/active/client_display_backend.md §7.
//
// IMPORTANT: getContext is one-shot — once a canvas yields a "webgl2"/"webgpu" context it can
// never yield "2d". So a GPU tier only calls getContext AFTER it knows it can succeed
// (WebGPU: an adapter is in hand; WebGL2: the probe returned non-null), and we fall back only
// when the canvas is still untouched. Async because WebGPU device acquisition is async.

import type { SurfacePreference } from "../types";
import { Canvas2dSurface } from "./canvas2dSurface";
import type { DisplaySurface } from "./displaySurface";
import { tryWebgl2, WebglSurface } from "./webglSurface";
import { tryWebgpu } from "./webgpuSurface";

/**
 * Build a display surface for `canvas`.
 *
 * - `"2d"` (default) → Canvas2D, always available.
 * - `"webgl"` → WebGL2 if available, else Canvas2D.
 * - `"webgpu"` → WebGPU if an adapter is available, else Canvas2D.
 * - `"auto"` → prefer WebGPU, then WebGL2, else Canvas2D.
 */
export async function createDisplaySurface(
  canvas: OffscreenCanvas,
  requested: SurfacePreference = "2d",
): Promise<DisplaySurface> {
  if (requested === "webgpu" || requested === "auto") {
    const wgpu = await tryWebgpu(canvas);
    if (wgpu) return wgpu;
    // No adapter — tryWebgpu only takes the context after one is in hand, so the canvas is
    // untouched here and remains available for the WebGL2/Canvas2D fallback below.
  }
  if (requested === "webgl" || requested === "auto") {
    const gl = tryWebgl2(canvas);
    if (gl) return new WebglSurface(canvas, gl);
  }
  return new Canvas2dSurface(canvas);
}
