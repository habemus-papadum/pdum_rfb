// Mode B (frame-as-texture) harness — the CALLER's side. Owns a WebGL2/WebGPU context,
// obtains the streamed frame as a texture (controlled input, or via FrameTextureFeed against
// the test server), composites it upright into its own canvas, reads the pixels back, and
// publishes them on window.__feed. This is the minimal version of the minimap/overlay worked
// example: sample the frame texture in the caller's own scene.

import { FrameTextureFeed, WebglFrameTexture, WebgpuFrameTexture } from "../src/index";

const params = new URLSearchParams(location.search);
const feedKind = params.get("feed") ?? "webgl";
const sourceKind = params.get("source") ?? "bitmap";
const [frameW, frameH] = (params.get("frame") ?? "64x64").split("x").map(Number);
const ws = params.get("ws"); // set → stream via FrameTextureFeed; unset → controlled input

type Readback = { kind: string; width: number; height: number; data: number[] };
function expose(rb: Readback): void {
  (globalThis as unknown as { __feed: Readback }).__feed = rb;
}

// ---- controlled asymmetric source (TL red / TR green / BL blue / BR white) ----
function makeSrcCanvas(): OffscreenCanvas {
  const c = new OffscreenCanvas(frameW, frameH);
  const ctx = c.getContext("2d")!;
  const hw = Math.floor(frameW / 2);
  const hh = Math.floor(frameH / 2);
  ctx.fillStyle = "rgb(255,0,0)";
  ctx.fillRect(0, 0, hw, hh);
  ctx.fillStyle = "rgb(0,255,0)";
  ctx.fillRect(hw, 0, frameW - hw, hh);
  ctx.fillStyle = "rgb(0,0,255)";
  ctx.fillRect(0, hh, hw, frameH - hh);
  ctx.fillStyle = "rgb(255,255,255)";
  ctx.fillRect(hw, hh, frameW - hw, frameH - hh);
  return c;
}
async function makeFrame(): Promise<VideoFrame | ImageBitmap> {
  const src = makeSrcCanvas();
  if (sourceKind === "videoframe") return new VideoFrame(src, { timestamp: 0 });
  return createImageBitmap(src);
}

// ---- WebGL caller composite: draw the frame texture upright, read it back ----
const VERT = `#version 300 es
in vec2 a; out vec2 v;
void main(){ vec2 q=a*0.5+0.5; v=vec2(q.x, 1.0-q.y); gl_Position=vec4(a,0,1); }`;
const FRAG = `#version 300 es
precision mediump float; in vec2 v; uniform sampler2D t; out vec4 o;
void main(){ o=texture(t,v); }`;

function compositeWebgl(gl: WebGL2RenderingContext, tex: WebGLTexture, W: number, H: number): Readback {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.bindAttribLocation(prog, 0, "a");
  gl.linkProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, W, H);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const raw = new Uint8ClampedArray(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const flip = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) flip.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  return { kind: "webgl", width: W, height: H, data: Array.from(flip) };
}

async function runWebgl(): Promise<void> {
  // Caller-sized canvas (stream size for streaming, frame size for the controlled 1:1 case).
  const [cw, ch] = ws ? [640, 480] : [frameW, frameH];
  const canvas = new OffscreenCanvas(cw, ch);
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true })!;
  if (ws) {
    // Streaming: the caller owns `gl`; the feed uploads each decoded frame into feed.texture,
    // and the caller composites it (here, upright into its own canvas) on every onFrame.
    const feed = new FrameTextureFeed({
      url: ws,
      gl,
      imageOnly: true,
      onFrame: () => {
        if (feed.texture) expose(compositeWebgl(gl, feed.texture, cw, ch));
      },
    });
    (globalThis as unknown as { __feedHandle: unknown }).__feedHandle = feed; // keep alive
  } else {
    const up = new WebglFrameTexture(gl);
    up.upload(await makeFrame(), frameW, frameH);
    expose(compositeWebgl(gl, up.texture, cw, ch));
  }
}

// ---- WebGPU caller composite ----
const WGSL = `
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{
  var q=array<vec2f,4>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(1,1));
  var o:VO; let c=q[i];
  o.p=vec4f(c.x*2-1, 1-c.y*2, 0, 1); o.uv=vec2f(c.x, c.y); return o;
}
@fragment fn fs(i:VO)->@location(0) vec4f{ return textureSample(t,s,i.uv); }`;

async function runWebgpu(): Promise<void> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  const adapter = gpu ? await gpu.requestAdapter() : null;
  if (!adapter) {
    expose({ kind: "none", width: 0, height: 0, data: [] }); // no adapter → spec skips
    return;
  }
  const device = await adapter.requestDevice();
  const up = new WebgpuFrameTexture(device);
  up.upload(await makeFrame(), frameW, frameH);
  const tex = up.currentTexture()!;
  const W = frameW;
  const H = frameH;
  const target = device.createTexture({
    size: [W, H],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const mod = device.createShaderModule({ code: WGSL });
  const pipe = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: mod, entryPoint: "vs" },
    fragment: { module: mod, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-strip" },
  });
  const bind = device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
      { binding: 1, resource: tex.createView() },
    ],
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bind);
  pass.draw(4);
  pass.end();
  const bpr = Math.ceil((W * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: H }, [W, H]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buf.getMappedRange());
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) out.set(padded.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
  buf.unmap();
  expose({ kind: "webgpu", width: W, height: H, data: Array.from(out) });
}

// Always publish __feed so the WebGPU feed spec can gate-and-skip instead of failing on a 10s
// waitForFunction timeout: on a headless runner without a usable WebGPU adapter, requestAdapter()
// / requestDevice() can hang or throw and never settle, which would otherwise leave __feed unset.
// The watchdog is scoped to the WebGPU path (the WebGL/streaming path publishes on its first
// frame and must not be spuriously marked unavailable); the catch covers a throw on either path.
const feedTarget = globalThis as unknown as { __feed?: unknown };
function publishFeedNone(reason: string): void {
  if (!feedTarget.__feed) {
    feedTarget.__feed = { kind: "none", reason, width: 0, height: 0, data: [] };
  }
}
if (feedKind === "webgpu") {
  const WEBGPU_WATCHDOG_MS = 6000; // < the spec's 10s waitForFunction, > any real feed init
  setTimeout(() => publishFeedNone("timed out acquiring WebGPU (no usable adapter?)"), WEBGPU_WATCHDOG_MS);
}
void (feedKind === "webgpu" ? runWebgpu() : runWebgl()).catch((err: unknown) => publishFeedNone(String(err)));
