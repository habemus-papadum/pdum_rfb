// Mode-A coordinator: owns the fit/background policy + current frame size, holds a
// DisplaySurface (the pluggable draw path — Canvas2D today, WebGL2/WebGPU later), and
// routes every draw/resize/fit-change to surface.present() with the geometry from the
// pure viewport.ts. Drawing (present) and event-mapping (backingToFrame) share that
// geometry, so a click is always accurate under any fit. This class holds no pixels
// itself — retention and the drawing target live in the surface.

import { presentGeometry, type FitMode, type ViewportState } from "../viewport";
import { Canvas2dSurface } from "./canvas2dSurface";
import type { DisplaySurface } from "./displaySurface";

export class Renderer {
  /** Fit mode when the frame AR differs from the canvas AR (default letterbox). */
  fit: FitMode = "contain";
  /** Letterbox fill for `contain` (any CSS color; default black). */
  background = "#000";
  /** Current decoded frame size (device px), updated on each draw. */
  frameW = 0;
  frameH = 0;

  private surface: DisplaySurface;

  constructor(public canvas: OffscreenCanvas) {
    this.surface = new Canvas2dSurface(canvas);
  }

  /** Choose the canvas color space (`"srgb"` | `"display-p3"`). Must be called before the
   *  first draw/readPixels; ignored once the context exists. */
  setColorSpace(space: PredefinedColorSpace): void {
    this.surface.setColorSpace(space);
  }

  resize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      // Resize the backing store (clears it), then repaint the retained frame at the new
      // size so a display resize doesn't flash blank (no decoder reset needed).
      this.surface.resize(width, height);
      this.present();
    }
  }

  /** Repaint the last retained frame with the current size/fit (no-op draw if none yet). Used
   *  after a resize or a fit change so the picture updates without waiting for the next frame. */
  redraw(): void {
    this.present();
  }

  /** The geometry state for the *current* frame size (used by the event path too). */
  viewportState(): ViewportState {
    return {
      frameW: this.frameW,
      frameH: this.frameH,
      backingW: this.canvas.width,
      backingH: this.canvas.height,
      fit: this.fit,
    };
  }

  /** Draw a decoded frame of `frameW x frameH` device px, letterboxed/cropped per `fit`. */
  draw(src: CanvasImageSource, frameW: number, frameH: number): void {
    this.frameW = frameW;
    this.frameH = frameH;
    this.surface.setFrame(src, frameW, frameH);
    this.present();
  }

  /** Present the retained frame with the current fit geometry + background. */
  private present(): void {
    this.surface.present(presentGeometry(this.viewportState()), this.background);
  }

  readPixels(): ImageData {
    return this.surface.readPixels();
  }

  toBlob(type = "image/png"): Promise<Blob> {
    return this.surface.toBlob(type);
  }

  dispose(): void {
    this.surface.dispose();
  }
}
