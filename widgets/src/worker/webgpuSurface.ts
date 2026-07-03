// WebGPU display backend (Mode A: managed present). Uploads the last decoded frame into a
// persistent RGBA GPU texture (copyExternalImageToTexture — handles both ImageBitmap and
// VideoFrame uniformly) and presents a `{src,dst}` region of it as a sampled quad. See
// displaySurface.ts and docs/proposals/active/client_display_backend.md.
//
// Design notes:
//   - Canvas format is forced to "rgba8unorm" so readPixels() gets RGBA with no swizzle.
//   - The dst rect is emitted as clip-space quad positions (not setViewport), so `cover`
//     overflow is clipped by the framebuffer without tripping WebGPU's viewport-bounds check.
//   - WebGPU sample space is top-left origin and copyExternalImageToTexture keeps the source
//     upright (flipY defaults false), so no Y-flip is needed (proven by the conformance
//     harness's asymmetric frame).
//   - Retention is a persistent texture, so resize re-presents cleanly (no §8 blank-gap in
//     the common case); device loss is the only unrecoverable case (blank until next frame).

import type { PresentGeometry } from "../viewport";
import type { DisplaySurface } from "./displaySurface";

const CANVAS_FORMAT: GPUTextureFormat = "rgba8unorm";

const SHADER = /* wgsl */ `
struct U { dst: vec4f, uv: vec4f };   // dst = (ndcL, ndcT, ndcR, ndcB); uv = (uOff, vOff, uScale, vScale)
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var q = array<vec2f, 4>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  let t = q[vi];
  let ndc = vec2f(mix(u.dst.x, u.dst.z, t.x), mix(u.dst.y, u.dst.w, t.y));
  var out: VSOut;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.uv = u.uv.xy + t * u.uv.zw;   // t.y=0 (screen top) -> v=uOff (frame top): upright
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}
`;

/** Try to build a WebGPU surface on `canvas`; returns null (canvas untouched) if no adapter,
 *  so the caller can fall back. Only calls getContext() AFTER a device is in hand. */
export async function tryWebgpu(canvas: OffscreenCanvas): Promise<WebgpuSurface | null> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    // Request timestamp-query when the adapter exposes it so the opt-in, benchmark-only
    // presentTimed() GPU timer can run. Harmless in production: enabling an unused feature
    // costs nothing, and the normal present() path never touches a query set.
    const device = await adapter.requestDevice(
      adapter.features.has("timestamp-query") ? { requiredFeatures: ["timestamp-query"] } : undefined,
    );
    const ctx = canvas.getContext("webgpu");
    if (!ctx) {
      device.destroy();
      return null;
    }
    return new WebgpuSurface(canvas, device, ctx);
  } catch {
    return null;
  }
}

export class WebgpuSurface implements DisplaySurface {
  readonly kind = "webgpu" as const;

  private colorSpace: PredefinedColorSpace = "srgb";
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuf: GPUBuffer;
  private frameTex: GPUTexture | null = null;
  private frameW = 0;
  private frameH = 0;
  private deviceLost = false;
  private bgCache = new Map<string, [number, number, number, number]>();
  private bgParser: OffscreenCanvasRenderingContext2D | null = null;

  constructor(
    private canvas: OffscreenCanvas,
    private device: GPUDevice,
    private ctx: GPUCanvasContext,
  ) {
    this.configure();
    void this.device.lost.then(() => {
      this.deviceLost = true;
      this.frameTex = null;
    });

    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: CANVAS_FORMAT }] },
      primitive: { topology: "triangle-strip" },
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.uniformBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private configure(): void {
    this.ctx.configure({ device: this.device, format: CANVAS_FORMAT, alphaMode: "opaque" });
  }

  setColorSpace(space: PredefinedColorSpace): void {
    // Set-once semantics like the other backends; colorSpace is fixed at configure time.
    if (space !== this.colorSpace && !this.frameTex) {
      this.colorSpace = space;
      this.ctx.configure({ device: this.device, format: CANVAS_FORMAT, alphaMode: "opaque", colorSpace: space });
    }
  }

  resize(backingW: number, backingH: number): void {
    if (backingW > 0 && backingH > 0) {
      this.canvas.width = backingW;
      this.canvas.height = backingH;
      this.configure(); // re-validate the swapchain; the retained frame texture is unaffected
    }
  }

  setFrame(src: CanvasImageSource, frameW: number, frameH: number): void {
    if (this.deviceLost) return;
    if (!this.frameTex || this.frameW !== frameW || this.frameH !== frameH) {
      this.frameTex?.destroy();
      this.frameTex = this.device.createTexture({
        size: [frameW, frameH],
        format: CANVAS_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.frameW = frameW;
      this.frameH = frameH;
    }
    // copyExternalImageToTexture reads a VideoFrame reliably across implementations, but NOT
    // an ImageBitmap/canvas on software adapters (Dawn/SwiftShader silently copies black), so
    // normalize non-VideoFrame sources through a VideoFrame. It copies synchronously, so the
    // (wrapped) frame can be closed right after.
    const isVideoFrame = typeof VideoFrame !== "undefined" && src instanceof VideoFrame;
    const frame = isVideoFrame ? (src as VideoFrame) : new VideoFrame(src, { timestamp: 0 });
    try {
      this.device.queue.copyExternalImageToTexture({ source: frame }, { texture: this.frameTex }, [frameW, frameH]);
    } finally {
      if (!isVideoFrame) frame.close();
    }
  }

  present(geom: PresentGeometry, background: string): void {
    if (this.deviceLost) return;
    this.lastGeom = geom;
    this.lastBg = background;
    const view = this.ctx.getCurrentTexture().createView();
    this.renderInto(view, geom, background);
  }

  /** Render the retained frame + background into a texture view (the canvas, or a readback
   *  target). Shared by present() and readPixels() so display and capture always agree. When
   *  `timed` and a query set exist, the render pass is wrapped in timestamp writes and resolved
   *  into `gpuReadBuf` (benchmark-only; presentTimed() reads the elapsed time back). */
  private renderInto(view: GPUTextureView, geom: PresentGeometry, background: string, timed = false): void {
    const [r, g, b, a] = this.parseColor(background);
    this.writeUniforms(geom);
    const encoder = this.device.createCommandEncoder();
    const withTimer = timed && !!this.gpuQuerySet;
    const passDesc: GPURenderPassDescriptor = {
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r, g, b, a } }],
    };
    if (withTimer) {
      passDesc.timestampWrites = { querySet: this.gpuQuerySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    }
    const pass = encoder.beginRenderPass(passDesc);
    if (this.frameTex) {
      const bind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuf } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.frameTex.createView() },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(4);
    }
    pass.end();
    if (withTimer && this.gpuResolveBuf && this.gpuReadBuf) {
      encoder.resolveQuerySet(this.gpuQuerySet!, 0, 2, this.gpuResolveBuf, 0);
      encoder.copyBufferToBuffer(this.gpuResolveBuf, 0, this.gpuReadBuf, 0, 16);
    }
    this.device.queue.submit([encoder.finish()]);
  }

  // --- Opt-in GPU render-pass timing (benchmark-only) --------------------------------------
  // The normal present()/readPixels() path never allocates or touches these; they exist so the
  // draw-path benchmark (widgets/demo/bench-harness.ts) can measure real GPU time for Mode A,
  // not just wall-clock submission. See docs/proposals/active/client_display_backend.md §15.
  private gpuQuerySet: GPUQuerySet | null = null;
  private gpuResolveBuf: GPUBuffer | null = null;
  private gpuReadBuf: GPUBuffer | null = null;

  /** Enable GPU render-pass timing for presentTimed(). Returns false when the device lacks the
   *  timestamp-query feature (e.g. some software adapters). Idempotent. */
  enableGpuTiming(): boolean {
    if (this.gpuQuerySet) return true;
    if (this.deviceLost || !this.device.features.has("timestamp-query")) return false;
    try {
      this.gpuQuerySet = this.device.createQuerySet({ type: "timestamp", count: 2 });
      this.gpuResolveBuf = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      this.gpuReadBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      return true;
    } catch {
      this.gpuQuerySet = null;
      return false;
    }
  }

  /** Present the retained frame AND measure the render-pass GPU time (ms). Resolves to null if
   *  timing isn't enabled or the timestamp read fails (it still presents in that case). Awaits a
   *  buffer map, so this is a benchmark path, not the hot present() loop. */
  async presentTimed(geom: PresentGeometry, background: string): Promise<number | null> {
    if (this.deviceLost) return null;
    this.lastGeom = geom;
    this.lastBg = background;
    const view = this.ctx.getCurrentTexture().createView();
    if (!this.gpuQuerySet || !this.gpuReadBuf) {
      this.renderInto(view, geom, background);
      return null;
    }
    this.renderInto(view, geom, background, true);
    try {
      await this.gpuReadBuf.mapAsync(GPUMapMode.READ);
      const ts = new BigInt64Array(this.gpuReadBuf.getMappedRange().slice(0));
      this.gpuReadBuf.unmap();
      const ns = Number(ts[1] - ts[0]); // WebGPU timestamps are nanoseconds
      return ns > 0 ? ns / 1e6 : null;
    } catch {
      return null;
    }
  }

  /** Pack the dst rect (as clip-space corners) and the src UV sub-rect into the uniform. */
  private writeUniforms(geom: PresentGeometry): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const { src, dst } = geom;
    const ndcL = (dst.x / w) * 2 - 1;
    const ndcR = ((dst.x + dst.w) / w) * 2 - 1;
    const ndcT = 1 - (dst.y / h) * 2; // canvas y-down -> clip y-up
    const ndcB = 1 - ((dst.y + dst.h) / h) * 2;
    const uOff = this.frameW > 0 ? src.x / this.frameW : 0;
    const vOff = this.frameH > 0 ? src.y / this.frameH : 0;
    const uScale = this.frameW > 0 ? src.w / this.frameW : 1;
    const vScale = this.frameH > 0 ? src.h / this.frameH : 1;
    // std140: two vec4f, tightly packed at offset 0 and 16.
    this.device.queue.writeBuffer(
      this.uniformBuf,
      0,
      new Float32Array([ndcL, ndcT, ndcR, ndcB, uOff, vOff, uScale, vScale]),
    );
  }

  async readPixels(): Promise<ImageData> {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const empty = new ImageData(w, h, { colorSpace: this.colorSpace });
    if (this.deviceLost) return empty;

    // Re-render the retained frame into a private target (COPY_SRC), so readback doesn't
    // depend on the swapchain texture's post-present lifetime. Uses the last present geometry.
    const target = this.device.createTexture({
      size: [w, h],
      format: CANVAS_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.renderInto(target.createView(), this.lastGeom ?? this.wholeCanvasGeom(), this.lastBg);

    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    const buf = this.device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow, rowsPerImage: h }, [w, h]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
    buf.unmap();
    buf.destroy();
    target.destroy();
    return new ImageData(out, w, h, { colorSpace: this.colorSpace });
  }

  toBlob(type = "image/png"): Promise<Blob> {
    return this.canvas.convertToBlob({ type });
  }

  dispose(): void {
    this.frameTex?.destroy();
    this.frameTex = null;
    try {
      this.gpuQuerySet?.destroy();
      this.gpuResolveBuf?.destroy();
      this.gpuReadBuf?.destroy();
      this.uniformBuf.destroy();
      this.device.destroy();
    } catch {
      /* already gone */
    }
    this.gpuQuerySet = null;
    this.bgCache.clear();
  }

  // present() records the geometry/background so readPixels() re-renders the same view.
  private lastGeom: PresentGeometry | null = null;
  private lastBg = "#000";
  private wholeCanvasGeom(): PresentGeometry {
    return {
      src: { x: 0, y: 0, w: this.frameW, h: this.frameH },
      dst: { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height },
    };
  }

  private parseColor(css: string): [number, number, number, number] {
    const hit = this.bgCache.get(css);
    if (hit) return hit;
    if (!this.bgParser) this.bgParser = new OffscreenCanvas(1, 1).getContext("2d");
    let rgba: [number, number, number, number] = [0, 0, 0, 1];
    const ctx = this.bgParser;
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      rgba = [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
    }
    this.bgCache.set(css, rgba);
    return rgba;
  }
}
