// OffscreenCanvas 2D wrapper: the single source of truth for backing size and the
// only thing that draws decoded frames. Geometry (fit / letterbox) lives in the
// pure viewport.ts; this class holds the current frame size + fit/background/color
// and routes every draw through frameDestRect so drawing and event-mapping agree.

import { frameDestRect, type FitMode, type ViewportState } from "../viewport";

export class Renderer {
  // Lazily created so the color space (from the server `config`, which arrives before
  // the first frame) can be chosen at getContext time — a 2D context's colorSpace is
  // fixed at creation and cannot be changed afterwards.
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private colorSpace: PredefinedColorSpace = "srgb";

  /** Fit mode when the frame AR differs from the canvas AR (default letterbox). */
  fit: FitMode = "contain";
  /** Letterbox fill for `contain` (any CSS color; default black). */
  background = "#000";
  /** Current decoded frame size (device px), updated on each draw. */
  frameW = 0;
  frameH = 0;

  constructor(public canvas: OffscreenCanvas) {}

  private context(): OffscreenCanvasRenderingContext2D {
    if (!this.ctx) {
      const ctx = this.canvas.getContext("2d", { colorSpace: this.colorSpace });
      if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
      this.ctx = ctx;
    }
    return this.ctx;
  }

  /** Choose the canvas color space (`"srgb"` | `"display-p3"`). Must be called before the
   *  first draw/readPixels (context creation); ignored once the context exists. */
  setColorSpace(space: PredefinedColorSpace): void {
    if (space !== this.colorSpace && !this.ctx) this.colorSpace = space;
  }

  resize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
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
    const ctx = this.context();
    // Clear to the background first so `contain` letterbox bars and any shrink on resize
    // don't show stale pixels. `fill`/`cover` overpaint it entirely.
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const { dx, dy, dw, dh } = frameDestRect(this.viewportState());
    ctx.drawImage(src, dx, dy, dw, dh);
  }

  readPixels(): ImageData {
    return this.context().getImageData(0, 0, this.canvas.width, this.canvas.height, {
      colorSpace: this.colorSpace,
    });
  }

  toBlob(type = "image/png"): Promise<Blob> {
    return this.canvas.convertToBlob({ type });
  }
}
