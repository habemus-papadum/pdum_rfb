// OffscreenCanvas 2D wrapper: the single source of truth for backing size and
// the only thing that draws decoded frames.

export class Renderer {
  private ctx: OffscreenCanvasRenderingContext2D;

  constructor(public canvas: OffscreenCanvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw(src: CanvasImageSource): void {
    this.ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height);
  }

  readPixels(): ImageData {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  toBlob(type = "image/png"): Promise<Blob> {
    return this.canvas.convertToBlob({ type });
  }
}
