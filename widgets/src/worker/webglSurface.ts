// WebGL2 display backend (Mode A: managed present). Retains the last decoded frame as a
// GPU texture and presents a `{src,dst}` region of it as a textured quad. Pixel-equivalent
// to the Canvas2D floor (canvas2dSurface.ts) — the e2e asserts both produce the same
// readback — but the frame lives on the GPU, which is the groundwork for Mode B compositing
// and WebGPU. See displaySurface.ts for the contract and
// docs/proposals/completed/client_display_backend.md.
//
// Coordinate conventions (the fiddly part, pinned by tests/e2e/surface-conformance.spec.ts):
//   - Upload with UNPACK_FLIP_Y_WEBGL = true, so frame row 0 (top) lands at texture t=1.
//   - Present maps the quad [0,1]^2 to the src sub-rect UV so the screen-top of `dst`
//     samples the top of `src` (upright), and sets gl.viewport to `dst` in GL's
//     bottom-left window space.
//   - readPixels flips rows back to ImageData's top-down order.

import type { PresentGeometry } from "../viewport";
import type { DisplaySurface } from "./displaySurface";

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
// u_uv.xy = UV offset, u_uv.zw = UV scale: maps the quad's [0,1] coords to the src sub-rect.
uniform vec4 u_uv;
void main() {
  vec2 q = a_pos * 0.5 + 0.5;      // NDC [-1,1] -> [0,1]
  v_uv = u_uv.xy + q * u_uv.zw;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() { outColor = texture(u_tex, v_uv); }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("WebGL: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`WebGL: shader compile failed: ${log}`);
  }
  return sh;
}

/** Try to create a WebGL2 context on `canvas`; returns null if unavailable (so the caller
 *  can fall back to Canvas2D — a null here means we have NOT consumed the canvas). */
export function tryWebgl2(canvas: OffscreenCanvas): WebGL2RenderingContext | null {
  try {
    return canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      // Keep the drawn frame readable by readPixels()/convertToBlob() after present().
      preserveDrawingBuffer: true,
    });
  } catch {
    return null;
  }
}

export class WebglSurface implements DisplaySurface {
  readonly kind = "webgl" as const;

  private colorSpace: PredefinedColorSpace = "srgb";
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quad: WebGLBuffer;
  private tex: WebGLTexture;
  private uUv: WebGLUniformLocation | null;
  private hasFrame = false;
  private frameW = 0;
  private frameH = 0;
  // Cached CSS-color -> [r,g,b,a] (0..1) parse; a tiny 2D canvas does the parsing.
  private bgCache = new Map<string, [number, number, number, number]>();
  private bgParser: OffscreenCanvasRenderingContext2D | null = null;

  constructor(
    private canvas: OffscreenCanvas,
    private gl: WebGL2RenderingContext,
  ) {
    const gl2 = gl;
    const vs = compile(gl2, gl2.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl2, gl2.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl2.createProgram();
    if (!program) throw new Error("WebGL: createProgram failed");
    gl2.attachShader(program, vs);
    gl2.attachShader(program, fs);
    gl2.bindAttribLocation(program, 0, "a_pos");
    gl2.linkProgram(program);
    gl2.deleteShader(vs);
    gl2.deleteShader(fs);
    if (!gl2.getProgramParameter(program, gl2.LINK_STATUS)) {
      const log = gl2.getProgramInfoLog(program);
      throw new Error(`WebGL: program link failed: ${log}`);
    }
    this.program = program;
    this.uUv = gl2.getUniformLocation(program, "u_uv");

    // A unit quad (TRIANGLE_STRIP) covering NDC [-1,1]^2.
    const quad = gl2.createBuffer();
    const vao = gl2.createVertexArray();
    if (!quad || !vao) throw new Error("WebGL: buffer/VAO alloc failed");
    gl2.bindVertexArray(vao);
    gl2.bindBuffer(gl2.ARRAY_BUFFER, quad);
    gl2.bufferData(gl2.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl2.STATIC_DRAW);
    gl2.enableVertexAttribArray(0);
    gl2.vertexAttribPointer(0, 2, gl2.FLOAT, false, 0, 0);
    gl2.bindVertexArray(null);
    this.quad = quad;
    this.vao = vao;

    const tex = gl2.createTexture();
    if (!tex) throw new Error("WebGL: texture alloc failed");
    gl2.bindTexture(gl2.TEXTURE_2D, tex);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
    this.tex = tex;

    gl2.disable(gl2.BLEND);
    gl2.disable(gl2.DEPTH_TEST);
    gl2.disable(gl2.SCISSOR_TEST);
  }

  setColorSpace(space: PredefinedColorSpace): void {
    if (space === this.colorSpace) return;
    this.colorSpace = space;
    // Best-effort: match Canvas2D's wide-gamut behavior where supported. Set-once semantics
    // like the 2D backend; harmless if the runtime ignores it.
    try {
      (this.gl as unknown as { drawingBufferColorSpace?: PredefinedColorSpace }).drawingBufferColorSpace = space;
      (this.gl as unknown as { unpackColorSpace?: PredefinedColorSpace }).unpackColorSpace = space;
    } catch {
      /* not supported on this runtime */
    }
  }

  resize(backingW: number, backingH: number): void {
    // The retained texture survives this — only the drawing buffer is re-allocated (cleared).
    if (backingW > 0 && backingH > 0) {
      this.canvas.width = backingW;
      this.canvas.height = backingH;
    }
  }

  setFrame(src: CanvasImageSource, frameW: number, frameH: number): void {
    const gl = this.gl;
    this.frameW = frameW;
    this.frameH = frameH;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // Do NOT use UNPACK_FLIP_Y_WEBGL: it is honored for a VideoFrame/canvas but IGNORED for an
    // ImageBitmap (its orientation is baked at creation), so it can't fix orientation
    // uniformly. Instead every source uploads frame-row-0 at texture t=0 (FLIP_Y off) and the
    // present() shader flips V, so all source types come out upright (checked by the harness).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // texImage2D copies synchronously, so the caller may close `src` right after.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.hasFrame = true;
  }

  present(geom: PresentGeometry, background: string): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const [r, g, b, a] = this.parseColor(background);
    gl.viewport(0, 0, w, h);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.hasFrame || this.frameW <= 0 || this.frameH <= 0) return;

    const { src, dst } = geom;
    // GL window space is bottom-left origin; dst is canvas (top-left) space. Overflow (cover)
    // is clipped to the framebuffer by the viewport.
    gl.viewport(dst.x, h - (dst.y + dst.h), dst.w, dst.h);

    // Map the quad's [0,1] to the src sub-rect UV. The texture is uploaded un-flipped (frame
    // row 0 at t=0), and the quad's q.y=1 is the screen TOP, so V must flip: screen-top
    // (q.y=1) samples the src top (t = src.y/frameH). Hence vOffset=frame-bottom, vScale<0.
    const uMinX = src.x / this.frameW;
    const uScaleX = src.w / this.frameW;
    const vOffset = (src.y + src.h) / this.frameH; // v at screen-bottom (q.y=0)
    const vScale = -src.h / this.frameH; // negative: v decreases toward screen-top

    gl.useProgram(this.program);
    gl.uniform4f(this.uUv, uMinX, vOffset, uScaleX, vScale);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  async readPixels(): Promise<ImageData> {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const raw = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // gl.readPixels is bottom-up (window origin); ImageData is top-down — flip rows.
    const flipped = new Uint8ClampedArray(w * h * 4);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const srcOff = (h - 1 - y) * rowBytes;
      flipped.set(raw.subarray(srcOff, srcOff + rowBytes), y * rowBytes);
    }
    return new ImageData(flipped, w, h, { colorSpace: this.colorSpace });
  }

  async toBlob(type = "image/png"): Promise<Blob> {
    // convertToBlob snapshots the (preserved) drawing buffer in the canvas's own orientation.
    return this.canvas.convertToBlob({ type });
  }

  dispose(): void {
    const gl = this.gl;
    try {
      gl.deleteTexture(this.tex);
      gl.deleteBuffer(this.quad);
      gl.deleteVertexArray(this.vao);
      gl.deleteProgram(this.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* context already gone */
    }
    this.hasFrame = false;
    this.bgCache.clear();
  }

  /** Parse any CSS color to normalized RGBA via a cached 1x1 2D canvas. */
  private parseColor(css: string): [number, number, number, number] {
    const hit = this.bgCache.get(css);
    if (hit) return hit;
    if (!this.bgParser) {
      this.bgParser = new OffscreenCanvas(1, 1).getContext("2d");
    }
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
