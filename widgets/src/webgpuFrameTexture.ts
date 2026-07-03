// Mode B (frame-as-texture), WebGPU. Keeps the current decoded frame available in the
// CALLER's WebGPU device, two ways (the zero-copy ↔ retention tension, §6.3):
//   - currentTexture(): a persistent rgba8unorm GPUTexture (a per-frame copy) the caller can
//     sample AND retain — works for every source type.
//   - importCurrentFrame(): a transient GPUExternalTexture sampled with NO copy — the true
//     zero-copy path, but only for VideoFrame sources and only valid within the current task.
// See docs/proposals/active/client_display_backend.md §5–6.

const FMT: GPUTextureFormat = "rgba8unorm";

/** Uploads decoded frames for a caller's WebGPU device; `upload()` TAKES OWNERSHIP of the
 *  frame (VideoFrames are held alive for importCurrentFrame; others are copied then closed). */
export class WebgpuFrameTexture {
  readonly kind = "webgpu" as const;
  frameW = 0;
  frameH = 0;
  private tex: GPUTexture | null = null;
  private held: VideoFrame | null = null; // the live VideoFrame, for zero-copy import

  constructor(private device: GPUDevice) {}

  upload(src: VideoFrame | ImageBitmap, frameW: number, frameH: number): void {
    const isVideoFrame = typeof VideoFrame !== "undefined" && src instanceof VideoFrame;
    if (!this.tex || this.frameW !== frameW || this.frameH !== frameH) {
      this.tex?.destroy();
      this.tex = this.device.createTexture({
        size: [frameW, frameH],
        format: FMT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.frameW = frameW;
      this.frameH = frameH;
    }
    // Persistent copy — normalize non-VideoFrame sources through a VideoFrame (software
    // adapters only copy from a VideoFrame; see §7.1).
    const frame = isVideoFrame ? (src as VideoFrame) : new VideoFrame(src, { timestamp: 0 });
    this.device.queue.copyExternalImageToTexture({ source: frame }, { texture: this.tex }, [frameW, frameH]);

    // Release the previously-held frame and keep this one alive iff it's a real VideoFrame
    // (so importCurrentFrame can do a zero-copy sample); otherwise close the wrapper + source.
    this.held?.close();
    if (isVideoFrame) {
      this.held = src as VideoFrame;
    } else {
      frame.close();
      src.close();
      this.held = null;
    }
  }

  /** Persistent RGBA texture the caller can sample and retain. Null before the first frame. */
  currentTexture(): GPUTexture | null {
    return this.tex;
  }

  /** Zero-copy external texture for the current VideoFrame — call INSIDE the render pass that
   *  samples it (it expires at task end). Null when the last frame wasn't a VideoFrame. */
  importCurrentFrame(): GPUExternalTexture | null {
    return this.held ? this.device.importExternalTexture({ source: this.held }) : null;
  }

  dispose(): void {
    this.tex?.destroy();
    this.tex = null;
    this.held?.close();
    this.held = null;
  }
}
