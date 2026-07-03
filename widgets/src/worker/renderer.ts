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

  // A 1:1 copy of the last decoded frame, kept at native resolution so we can repaint on a
  // display-only resize / fit change WITHOUT a decoder reset (the source VideoFrame is closed
  // right after draw, so we can't reach it later). Lets a resize keep the picture up instead of
  // going blank until the next frame.
  private lastFrame: OffscreenCanvas | null = null;
  private lastFrameCtx: OffscreenCanvasRenderingContext2D | null = null;

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
      // Setting the backing size clears the canvas — repaint the retained frame immediately at
      // the new size so a display resize doesn't flash blank (no decoder reset needed).
      this.canvas.width = width;
      this.canvas.height = height;
      this.redraw();
    }
  }

  /** Repaint the last retained frame with the current size/fit (no-op draw if none yet). Used
   *  after a resize or a fit change so the picture updates without waiting for the next frame. */
  redraw(): void {
    this.paint();
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
    this.retain(src, frameW, frameH);
    this.paint();
  }

  /** Keep a native-resolution copy of the last frame for repaint-on-resize. */
  private retain(src: CanvasImageSource, frameW: number, frameH: number): void {
    if (!this.lastFrame || this.lastFrame.width !== frameW || this.lastFrame.height !== frameH) {
      this.lastFrame = new OffscreenCanvas(frameW, frameH);
      this.lastFrameCtx = this.lastFrame.getContext("2d", { colorSpace: this.colorSpace });
    }
    this.lastFrameCtx?.drawImage(src, 0, 0, frameW, frameH);
  }

  /** Paint the retained frame onto the canvas with the current size + fit geometry. */
  private paint(): void {
    const ctx = this.context();
    // Clear to the background first so `contain` letterbox bars and any shrink on resize
    // don't show stale pixels. `fill`/`cover` overpaint it entirely.
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.lastFrame) {
      const { dx, dy, dw, dh } = frameDestRect(this.viewportState());
      ctx.drawImage(this.lastFrame, dx, dy, dw, dh);
    }
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
