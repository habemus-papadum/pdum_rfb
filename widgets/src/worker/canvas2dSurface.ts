// Canvas2D display backend: the floor draw path (always available). Retains the last
// decoded frame as a native-resolution OffscreenCanvas copy and presents a `{src,dst}`
// region of it with drawImage. See displaySurface.ts for the contract and
// docs/proposals/completed/client_display_backend.md for how WebGL2/WebGPU slot in beside it.

import type { PresentGeometry } from "../viewport";
import type { DisplaySurface } from "./displaySurface";

export class Canvas2dSurface implements DisplaySurface {
  readonly kind = "2d" as const;

  // Lazily created so the color space (from the server `config`, which arrives before
  // the first frame) can be chosen at getContext time — a 2D context's colorSpace is
  // fixed at creation and cannot be changed afterwards.
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private colorSpace: PredefinedColorSpace = "srgb";

  // A 1:1 copy of the last decoded frame, kept at native resolution so we can repaint on a
  // display-only resize / fit change WITHOUT a decoder reset (the source VideoFrame is closed
  // right after setFrame, so we can't reach it later). Lets a resize keep the picture up
  // instead of going blank until the next frame.
  private lastFrame: OffscreenCanvas | null = null;
  private lastFrameCtx: OffscreenCanvasRenderingContext2D | null = null;

  constructor(private canvas: OffscreenCanvas) {}

  private context(): OffscreenCanvasRenderingContext2D {
    if (!this.ctx) {
      const ctx = this.canvas.getContext("2d", { colorSpace: this.colorSpace });
      if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
      this.ctx = ctx;
    }
    return this.ctx;
  }

  setColorSpace(space: PredefinedColorSpace): void {
    if (space !== this.colorSpace && !this.ctx) this.colorSpace = space;
  }

  resize(backingW: number, backingH: number): void {
    // Setting the backing size clears the canvas — the caller re-presents the retained
    // frame at the new size so a display resize doesn't flash blank (no decoder reset needed).
    if (backingW > 0 && backingH > 0) {
      this.canvas.width = backingW;
      this.canvas.height = backingH;
    }
  }

  /** Keep a native-resolution copy of the last frame for repaint-on-resize. */
  setFrame(src: CanvasImageSource, frameW: number, frameH: number): void {
    if (!this.lastFrame || this.lastFrame.width !== frameW || this.lastFrame.height !== frameH) {
      this.lastFrame = new OffscreenCanvas(frameW, frameH);
      this.lastFrameCtx = this.lastFrame.getContext("2d", { colorSpace: this.colorSpace });
    }
    this.lastFrameCtx?.drawImage(src, 0, 0, frameW, frameH);
  }

  present(geom: PresentGeometry, background: string): void {
    const ctx = this.context();
    // Clear to the background first so `contain` letterbox bars and any shrink on resize
    // don't show stale pixels. `fill`/`cover` overpaint it entirely.
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.lastFrame) {
      const { src, dst } = geom;
      ctx.drawImage(this.lastFrame, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
    }
  }

  async readPixels(): Promise<ImageData> {
    return this.context().getImageData(0, 0, this.canvas.width, this.canvas.height, {
      colorSpace: this.colorSpace,
    });
  }

  toBlob(type = "image/png"): Promise<Blob> {
    return this.canvas.convertToBlob({ type });
  }

  dispose(): void {
    this.lastFrame = null;
    this.lastFrameCtx = null;
    this.ctx = null;
  }
}
