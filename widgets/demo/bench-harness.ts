// Draw-path benchmark harness (main-thread, server-free). Measures the per-frame present
// cost of the display-backend draw paths so the "Canvas2D is the default, GPU is opt-in"
// hunch in docs/proposals/active/client_display_backend.md can be MEASURED, not guessed.
//
// It answers two questions:
//   1. Mode A (managed present): how much does setFrame()+present() cost per frame on each of
//      Canvas2D / WebGL2 / WebGPU, over a known moving frame sequence?
//   2. Mode B (frame-as-texture): how much does upload-into-caller-texture + a representative
//      composite draw cost on WebGL2 / WebGPU — i.e. is the decode-straight-to-GPU-texture
//      path's overhead worth it vs Mode A present?
//
// Metrics per run (all in milliseconds, main-thread wall-clock via performance.now()):
//   - submitMs {mean,median,p95,min,max}: the headline — time around the draw calls
//     (setFrame+present for A; upload+composite for B). This is the CPU-side command-
//     submission cost; GPU execution is deferred and NOT included here (see flushMs).
//   - createMs {...}: per-frame source-frame construction (VideoFrame/ImageBitmap) — reported
//     for context so it isn't conflated with the draw cost.
//   - flushMs: one value — how long a final GPU flush (readback / onSubmittedWorkDone) took
//     after all submits, i.e. how much GPU backlog had to drain. A hint at hidden GPU cost.
//   - gpuMs {...} | null: real GPU pass time from WebGPU timestamp queries when the adapter
//     exposes "timestamp-query" (Mode B WebGPU only); null + a note otherwise.
//
// IMPORTANT caveat baked into the output: under headless SwiftShader (the CI/agent config)
// the GPU is a software rasteriser, so absolute WebGL/WebGPU numbers are NOT representative of
// real-GPU performance. The value here is (a) the repeatable harness, (b) the Canvas2D-vs-
// WebGL relative read, and (c) the methodology. Real-GPU numbers come from a human running
// this on hardware.

import type { SurfacePreference } from "../src/types";
import { presentGeometry, type FitMode } from "../src/viewport";
import { createDisplaySurface } from "../src/worker/surfaceFactory";
import { WebglFrameTexture, WebgpuFrameTexture } from "../src/index";

const params = new URLSearchParams(location.search);
const mode = (params.get("mode") ?? "A").toUpperCase(); // "A" present | "B" frame-as-texture
const requested = (params.get("surface") as SurfacePreference | null) ?? "2d"; // Mode A backend
const feedKind = params.get("feed") ?? "webgl"; // Mode B: "webgl" | "webgpu"
const sourceKind = params.get("source") ?? "videoframe"; // "videoframe" (sync) | "bitmap" (async)
const [frameW, frameH] = (params.get("frame") ?? "1280x720").split("x").map(Number);
const [backingW, backingH] = (params.get("backing") ?? `${frameW}x${frameH}`).split("x").map(Number);
const fit = (params.get("fit") as FitMode | null) ?? "contain";
const background = params.get("bg") ?? "#000";
const frames = Number(params.get("frames") ?? 180);
const warmup = Number(params.get("warmup") ?? 20);
const poolSize = Number(params.get("pool") ?? 12);

interface Summary {
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  n: number;
}

function summarize(xs: number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length || 1;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] ?? 0;
  return { mean, median: at(0.5), p95: at(0.95), min: s[0] ?? 0, max: s[s.length - 1] ?? 0, n: xs.length };
}

interface BenchResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  mode: string;
  backend: string; // actual backend obtained (after any fallback)
  requested: string;
  source: string;
  frameW: number;
  frameH: number;
  backingW: number;
  backingH: number;
  fit: string;
  frames: number;
  warmup: number;
  submitMs?: Summary;
  createMs?: Summary;
  flushMs?: number;
  gpuMs?: Summary | null;
  gpuNote?: string;
  userAgent: string;
}

function expose(r: Partial<BenchResult> & { backend: string; mode: string }): void {
  const full: BenchResult = {
    ok: !r.skipped,
    mode: r.mode,
    backend: r.backend,
    requested,
    source: sourceKind,
    frameW,
    frameH,
    backingW,
    backingH,
    fit,
    frames,
    warmup,
    userAgent: navigator.userAgent,
    ...r,
  };
  (globalThis as unknown as { __bench: BenchResult }).__bench = full;
  const out = document.getElementById("out");
  if (out) out.textContent = JSON.stringify(full, null, 2);
}

// ---- a known, deterministic, MOVING frame sequence -----------------------------------------
// Distinct content per pool slot (a moving white box + varying gradient + speckle) so the
// driver can't elide a redundant upload, mirroring a real changing stream.
function makePool(n: number, w: number, h: number): OffscreenCanvas[] {
  const pool: OffscreenCanvas[] = [];
  for (let i = 0; i < n; i++) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${(i * 37) % 360} 80% 45%)`);
    g.addColorStop(1, `hsl(${(i * 37 + 140) % 360} 80% 20%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const bw = Math.max(4, (w * 0.2) | 0);
    const bh = Math.max(4, (h * 0.2) | 0);
    const bx = ((i / n) * (w - bw)) | 0;
    ctx.fillStyle = "white";
    ctx.fillRect(bx, (h * 0.4) | 0, bw, bh);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    for (let k = 0; k < 300; k++) {
      const x = ((Math.sin(i * 1.3 + k * 2.1) * 0.5 + 0.5) * w) | 0;
      const y = ((Math.cos(i * 0.7 + k * 1.7) * 0.5 + 0.5) * h) | 0;
      ctx.fillRect(x, y, 3, 3);
    }
    pool.push(c);
  }
  return pool;
}

const pool = makePool(poolSize, frameW, frameH);

async function makeFrame(src: OffscreenCanvas, ts: number): Promise<VideoFrame | ImageBitmap> {
  if (sourceKind === "bitmap") return createImageBitmap(src);
  return new VideoFrame(src, { timestamp: ts });
}

// ---- Mode A: managed present through a DisplaySurface --------------------------------------
async function runModeA(): Promise<void> {
  const canvas = new OffscreenCanvas(backingW, backingH);
  const surface = await createDisplaySurface(canvas, requested);
  // Requested a GPU tier but fell back (no adapter) → report skipped so the spec can skip.
  if (requested !== "auto" && surface.kind !== requested) {
    expose({ mode: "A", backend: surface.kind, skipped: true, reason: `requested ${requested}, got ${surface.kind}` });
    return;
  }
  const geom = presentGeometry({ frameW, frameH, backingW, backingH, fit });
  const create: number[] = [];
  const submit: number[] = [];
  for (let i = 0; i < warmup + frames; i++) {
    const c0 = performance.now();
    const frame = await makeFrame(pool[i % pool.length], i * 1000);
    const c1 = performance.now();
    surface.setFrame(frame, frameW, frameH);
    surface.present(geom, background);
    const t1 = performance.now();
    (frame as { close?: () => void }).close?.();
    if (i >= warmup) {
      create.push(c1 - c0);
      submit.push(t1 - c1);
    }
  }
  const f0 = performance.now();
  await surface.readPixels(); // final flush: forces all queued GPU work to complete
  const flushMs = performance.now() - f0;

  // Real GPU render-pass time for Mode A, when the backend exposes the opt-in timer (WebGPU
  // with the timestamp-query feature — see webgpuSurface.ts). A separate short pass so the
  // per-frame map/await doesn't contaminate submitMs above.
  let gpuMs: Summary | null = null;
  let gpuNote = "wall-clock present only (no GPU timer on this backend)";
  const timed = surface as unknown as {
    enableGpuTiming?: () => boolean;
    presentTimed?: (g: typeof geom, bg: string) => Promise<number | null>;
  };
  if (timed.enableGpuTiming && timed.presentTimed) {
    if (timed.enableGpuTiming()) {
      const gs: number[] = [];
      for (let i = 0; i < 30; i++) {
        const frame = await makeFrame(pool[i % pool.length], i * 1000);
        surface.setFrame(frame, frameW, frameH);
        const ms = await timed.presentTimed(geom, background);
        (frame as { close?: () => void }).close?.();
        if (ms != null) gs.push(ms);
      }
      if (gs.length) {
        gpuMs = summarize(gs);
        gpuNote = "GPU time from timestamp-query (present render pass)";
      } else {
        gpuNote = "timestamp-query enabled but no valid samples";
      }
    } else {
      gpuNote = "wall-clock present only (adapter lacks timestamp-query)";
    }
  }

  surface.dispose();
  expose({
    mode: "A",
    backend: surface.kind,
    submitMs: summarize(submit),
    createMs: summarize(create),
    flushMs,
    gpuMs,
    gpuNote,
  });
}

// ---- Mode B WebGL2: upload into a caller texture, composite a quad --------------------------
const B_VERT = `#version 300 es
in vec2 a; out vec2 v;
void main(){ vec2 q=a*0.5+0.5; v=vec2(q.x, 1.0-q.y); gl_Position=vec4(a,0,1); }`;
const B_FRAG = `#version 300 es
precision mediump float; in vec2 v; uniform sampler2D t; out vec4 o;
void main(){ o=texture(t,v); }`;

async function runModeBWebgl(): Promise<void> {
  const canvas = new OffscreenCanvas(backingW, backingH);
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
  if (!gl) {
    expose({ mode: "B", backend: "none", skipped: true, reason: "no WebGL2 context" });
    return;
  }
  const up = new WebglFrameTexture(gl);
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, B_VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, B_FRAG));
  gl.bindAttribLocation(prog, 0, "a");
  gl.linkProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(prog);
  gl.viewport(0, 0, backingW, backingH);

  const drawQuad = () => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, up.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const create: number[] = [];
  const submit: number[] = [];
  for (let i = 0; i < warmup + frames; i++) {
    const c0 = performance.now();
    const frame = await makeFrame(pool[i % pool.length], i * 1000);
    const c1 = performance.now();
    up.upload(frame, frameW, frameH); // takes ownership + closes the frame
    drawQuad();
    const t1 = performance.now();
    if (i >= warmup) {
      create.push(c1 - c0);
      submit.push(t1 - c1);
    }
  }
  const f0 = performance.now();
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // final flush (GPU→CPU sync)
  const flushMs = performance.now() - f0;
  up.dispose();
  expose({
    mode: "B",
    backend: "webgl",
    submitMs: summarize(submit),
    createMs: summarize(create),
    flushMs,
    gpuMs: null,
    gpuNote: "wall-clock present only (WebGL2 EXT_disjoint_timer_query unavailable headless)",
  });
}

// ---- Mode B WebGPU: upload into a caller texture, composite, optional timestamp query -------
const B_WGSL = `
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i:u32)->VO{
  var q=array<vec2f,4>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(1,1));
  var o:VO; let c=q[i];
  o.p=vec4f(c.x*2-1, 1-c.y*2, 0, 1); o.uv=vec2f(c.x, c.y); return o;
}
@fragment fn fs(i:VO)->@location(0) vec4f{ return textureSample(t,s,i.uv); }`;

async function runModeBWebgpu(): Promise<void> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  const adapter = gpu ? await gpu.requestAdapter() : null;
  if (!adapter) {
    expose({ mode: "B", backend: "none", skipped: true, reason: "no WebGPU adapter" });
    return;
  }
  const canTimestamp = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice(canTimestamp ? { requiredFeatures: ["timestamp-query"] } : {});
  const canvas = new OffscreenCanvas(backingW, backingH);
  const ctx = canvas.getContext("webgpu")!;
  const format: GPUTextureFormat = "rgba8unorm";
  ctx.configure({ device, format, alphaMode: "opaque" });
  const up = new WebgpuFrameTexture(device);
  const module = device.createShaderModule({ code: B_WGSL });
  const pipe = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-strip" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

  // Optional GPU-time capture via a 2-entry timestamp query set (best-effort; guarded).
  let querySet: GPUQuerySet | null = null;
  let resolveBuf: GPUBuffer | null = null;
  let readBuf: GPUBuffer | null = null;
  const gpuSamples: number[] = [];
  if (canTimestamp) {
    try {
      querySet = device.createQuerySet({ type: "timestamp", count: 2 });
      resolveBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      readBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    } catch {
      querySet = null;
    }
  }

  const composite = (withTimestamp: boolean): GPUCommandEncoder => {
    const tex = up.currentTexture()!;
    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: tex.createView() },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
      ...(withTimestamp && querySet
        ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
        : {}),
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.draw(4);
    pass.end();
    return enc;
  };

  const create: number[] = [];
  const submit: number[] = [];
  for (let i = 0; i < warmup + frames; i++) {
    const c0 = performance.now();
    const frame = await makeFrame(pool[i % pool.length], i * 1000);
    const c1 = performance.now();
    up.upload(frame, frameW, frameH);
    const enc = composite(false);
    device.queue.submit([enc.finish()]);
    const t1 = performance.now();
    if (i >= warmup) {
      create.push(c1 - c0);
      submit.push(t1 - c1);
    }
  }
  const f0 = performance.now();
  await device.queue.onSubmittedWorkDone(); // final flush
  const flushMs = performance.now() - f0;

  // A short, separate pass to read real GPU time without contaminating submitMs above.
  let gpuMs: Summary | null = null;
  if (querySet && resolveBuf && readBuf) {
    try {
      for (let i = 0; i < 30; i++) {
        const frame = await makeFrame(pool[i % pool.length], i * 1000);
        up.upload(frame, frameW, frameH);
        const enc = composite(true);
        enc.resolveQuerySet(querySet, 0, 2, resolveBuf, 0);
        enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, 16);
        device.queue.submit([enc.finish()]);
        await readBuf.mapAsync(GPUMapMode.READ);
        const ts = new BigInt64Array(readBuf.getMappedRange().slice(0));
        readBuf.unmap();
        const ns = Number(ts[1] - ts[0]); // WebGPU timestamps are nanoseconds
        if (ns > 0) gpuSamples.push(ns / 1e6);
      }
      if (gpuSamples.length) gpuMs = summarize(gpuSamples);
    } catch {
      gpuMs = null;
    }
  }

  up.dispose();
  expose({
    mode: "B",
    backend: "webgpu",
    submitMs: summarize(submit),
    createMs: summarize(create),
    flushMs,
    gpuMs,
    gpuNote: canTimestamp
      ? "GPU time from timestamp-query (render pass only)"
      : "wall-clock present only (adapter lacks timestamp-query)",
  });
}

async function main(): Promise<void> {
  try {
    if (mode === "B") {
      if (feedKind === "webgpu") await runModeBWebgpu();
      else await runModeBWebgl();
    } else {
      await runModeA();
    }
  } catch (err) {
    expose({ mode, backend: "error", skipped: true, reason: String(err) });
  }
}

void main();
