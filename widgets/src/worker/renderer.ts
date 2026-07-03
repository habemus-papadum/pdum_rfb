// Mode-A coordinator: owns the fit/background policy + current frame size, holds a
// DisplaySurface (the pluggable draw path — Canvas2D today, WebGL2/WebGPU later), and
// routes every draw/resize/fit-change to surface.present() with the geometry from the
// pure viewport.ts. Drawing (present) and event-mapping (backingToFrame) share that
// geometry, so a click is always accurate under any fit. This class holds no pixels
// itself — retention and the drawing target live in the surface.

import type { SurfaceKind } from "../types";
import { presentGeometry, type FitMode, type ViewportState } from "../viewport";
import type { DisplaySurface } from "./displaySurface";
import { closeFrame, type FrameSink } from "./frameSink";

export class Renderer implements FrameSink {
  /** Fit mode when the frame AR differs from the canvas AR (default letterbox). */
  fit: FitMode = "contain";
  /** Letterbox fill for `contain` (any CSS color; default black). */
  background = "#000";
  /** Current decoded frame size (device px), updated on each draw. */
  frameW = 0;
  frameH = 0;

  /** Construct with the canvas and the chosen display backend (built by the worker via
   *  createDisplaySurface, so the fallback/selection policy stays in one place). */
  constructor(
    public canvas: OffscreenCanvas,
    private surface: DisplaySurface,
  ) {}

  /** Which draw path is active (`"2d"` | `"webgl"` | `"webgpu"`) — surfaced in Stats. */
  get surfaceKind(): SurfaceKind {
    return this.surface.kind;
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

  /** Draw a decoded frame of `frameW x frameH` device px, letterboxed/cropped per `fit`.
   *  Takes ownership of `src`: setFrame copies it synchronously, then we close it. */
  draw(src: CanvasImageSource, frameW: number, frameH: number): void {
    try {
      this.frameW = frameW;
      this.frameH = frameH;
      this.surface.setFrame(src, frameW, frameH);
      this.present();
    } finally {
      closeFrame(src);
    }
  }

  /** Present the retained frame with the current fit geometry + background. */
  private present(): void {
    this.surface.present(presentGeometry(this.viewportState()), this.background);
  }

  readPixels(): Promise<ImageData> {
    return this.surface.readPixels();
  }

  toBlob(type = "image/png"): Promise<Blob> {
    return this.surface.toBlob(type);
  }

  dispose(): void {
    this.surface.dispose();
  }
}
