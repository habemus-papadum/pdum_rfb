# Client display backend: a pluggable draw path (Canvas2D / WebGL / WebGPU)

> **Status: in progress.** Splits roadmap item 1 (formerly "client-side viewport:
> crop, zoom, pan") into two layers: **(1)** this low-level *display backend* — the
> thing that turns a decoded frame into pixels, with the draw path (`drawImage` /
> WebGL / WebGPU) chosen by capability and no presentation policy of its own; and
> **(2)** the *core viewport UI* (crop/zoom/pan) built on top of it. This doc fleshes
> out layer 1 and defines the seam layer 2 plugs into. Two things shape the design
> that emerged in review: the browser's **decode memory model** (§5 — you cannot
> decode into memory you own) and the need to let a client **composite the frame into
> its own hardware scene**, not just present it (the Mode A / Mode B split, §6). See
> [roadmap](../../roadmap.md) items 1 and 2.
>
> **Progress against §13:** **P1 ✅ landed** — the `DisplaySurface` seam
> (`widgets/src/worker/displaySurface.ts`), the Canvas2D backend
> (`canvas2dSurface.ts`), and `viewport.ts`'s `{src,dst}` `presentGeometry`; `Renderer`
> is now a thin coordinator; pure refactor, all tests green. **P2 ✅ landed** — the
> WebGL2 backend (`webglSurface.ts`) + `createDisplaySurface` selection
> (`surfaceFactory.ts`) + the `surface` option (`"2d"` default, `"auto"`/`"webgl"`/
> `"webgpu"` opt-in) reported on `stats.surface`. **WebGPU Mode A ✅ landed** (the
> `DisplaySurface` half of P5) — `webgpuSurface.ts` + the async factory + a gated
> `chromium-webgpu` Playwright project. All three backends are verified pixel-equal to
> Canvas2D by a server-free controlled-input harness across **both real source types**
> (ImageBitmap + VideoFrame — see the orientation findings in §7.1), plus the real
> decode→WebGL streaming path. **P3+P4+P5(Mode B) ✅ landed** — the **topology handoff**
> (dual-mode worker: `present` | `feed`; a `FrameSink` seam; frames transferred to the
> main thread) and **Mode B** frame-as-texture: `FrameTextureFeed` (public) binding to
> the caller's WebGL2/WebGPU context, with `WebglFrameTexture` (`.texture`) and
> `WebgpuFrameTexture` (`currentTexture()` + zero-copy `importCurrentFrame()`). Verified
> by a Mode B conformance harness (the caller composites the frame texture, both source
> types, WebGL + WebGPU) and a `FrameTextureFeed` streaming e2e.
>
> **The whole of roadmap item 1 (both modes, all three backends) is now landed and
> verified** (29 e2e across two projects + 69 unit). The remaining `docs/roadmap.md`
> item-1 follow-ups are polish, listed in §13 "Future".
>
> **Plan adaptations (recorded):** (1) Web Workers have **no `requestAnimationFrame`**,
> and Mode A present runs in the worker — so P3's "rAF present loop" is really the
> *caller's* loop in Mode B (the caller owns rendering; we keep the texture current and
> fire `onFrame`), which is why P3 shipped folded into Mode B. (2) WebGPU Mode A was
> pulled ahead of Mode B to complete the three-backend headline first.

This is a **client** concern only. It is unrelated to the server-side
[`wgpu` → NVENC/VideoToolbox zero-copy](wgpu_nvenc_zerocopy.md) work (that couples a
`wgpu`-rendered frame to a hardware *encoder*); this is about how the browser
*decodes* a frame and *presents or composites* it. The two share the acronym
"WebGPU/GPU" and nothing else.

---

## 1. Why split the roadmap item

The original item 1 bundled two things that live at different altitudes:

- **How you draw a frame** — `drawImage` a `VideoFrame` onto a 2D canvas, or upload
  it to a texture and sample it on the GPU. A low-level capability with *no
  presentation opinion*: it just gets "this source region of the current frame goes
  to that destination region." Useful on its own — a plain fit-to-window viewer needs
  a draw path even with zero zoom/pan.
- **What you present** — the viewport policy (fit / cover / 1:1 / zoom / pan /
  center-on-point), the gestures that drive it, the event inverse-mapping. This is UI,
  and it is where the roadmap's crop/zoom/pan actually lives.

The maintainer's note on the old item — *"a compositing flow is useful for other
things; in some sense this is lower-level functionality than the UI core"* — is
exactly this split, and it goes further than zoom/pan: the payoff of a real GPU draw
path is that **the frame becomes a first-class input to a client-side hardware scene**
(§6, Mode B), not merely a faster `drawImage`. Draw-path selection is a floor many
features stand on; pinning it under the viewport UI would bury it. So: build the
backend first, as its own layer with its own tests, then build the viewport on top.

"Backend" here means the *compositing/present* backend — Canvas2D, WebGL2, or WebGPU —
**not** the decoder (WebCodecs) and **not** the transport. Decoding is unchanged; only
the surface the decoded frame lands on becomes pluggable.

---

## 2. Where we are today

One class, `widgets/src/worker/renderer.ts` (`Renderer`), tangles three concerns:

1. **The surface** — owns the transferred `OffscreenCanvas` and its 2D context (color
   space fixed at `getContext` time).
2. **Retention + resize resilience** — keeps a native-resolution `OffscreenCanvas`
   copy of the last decoded frame (`lastFrame`) so a *display-only* resize/fit change
   repaints in place instead of going blank (the source `VideoFrame`/`ImageBitmap` is
   `close()`d immediately after draw).
3. **Compositing** — routes every paint through `frameDestRect()`
   (`widgets/src/viewport.ts`) so drawing and event-mapping agree, then a single
   `ctx.drawImage(lastFrame, dx, dy, dw, dh)`.

The decode side (`worker/videoDecode.ts`, `worker/imageDecode.ts`) already produces a
`CanvasImageSource` (a `VideoFrame` or `ImageBitmap`) and hands it to
`renderer.draw(src, frameW, frameH)`. The event path (`worker/entry.ts::mapEvent`)
inverts the *same* geometry via `backingToFrame()`. `viewport.ts` already **reserves
`zoom` / `panX` / `panY`** (identity today).

What's rigid, and what's simply absent:

- **The draw call is hard-coded to Canvas2D `drawImage`.** No seam for a GPU sampler.
- **The frame is never exposed as a texture.** Today's model is *managed-only*: the
  library owns the canvas and paints; a caller cannot get the frame as a GPU resource
  to composite into its own scene. That is the capability §6's Mode B adds.
- **Present is triggered by decode.** `draw()` calls `paint()`; there is no present
  loop independent of frame arrival. Smooth pan/zoom needs to re-present the *same*
  retained frame at display refresh while a gesture is in flight.
- **The composite primitive is whole-frame.** `frameDestRect` maps the *entire* frame
  into a dest rect. A crop/zoom needs a **source sub-rect** too.

---

## 3. Goals & non-goals

**Goals**

- A narrow `DisplaySurface` interface with **three interchangeable backends**
  (Canvas2D today's floor; WebGL2; WebGPU) selected by capability, `drawImage` always
  the fallback.
- **Two access modes** (§6): **Mode A — managed present** (we own the canvas and draw
  a `{src,dst}`), and **Mode B — frame-as-texture** (we keep the current frame
  uploaded as a backend-native GPU resource *in the caller's* context, and the caller
  composites it into its own hardware scene). Mode B is the real reason the GPU
  backends exist.
- **No presentation policy in the backend.** Mode A takes an explicit `{src,dst}` and
  draws; it knows nothing about fit/zoom/pan. Mode B draws nothing at all.
- Preserve the **retain-and-repaint-on-resize** invariant where it is cheap (Canvas2D,
  WebGL2) and **deliberately relax it for WebGPU Mode A** (§8): rather than pay
  complexity/perf to hold a persistent texture across a swapchain reconfigure, accept a
  brief transient and surface it through the existing status overlay.
- **Decouple present cadence from decode cadence** (a present loop the viewport can
  drive at display refresh) without changing the push model for frame *arrival*.
- **Worker-topology flexibility**: decode+present in one worker (today), or decode in
  one owner and present/composite in another (a second worker, or the main thread), by
  moving a `Transferable` frame handle.
- Keep geometry **pure and unit-tested** (`viewport.ts`), and keep the cross-language
  pixel contract (`render_test_pattern` / `expected_quadrant_color`) as the
  backend-conformance oracle.

**Non-goals (this layer)**

- Zoom/pan/crop *UI*, gestures, presets — layer 2 (roadmap item 2), described in §10
  only to prove the seam fits.
- A backend-switch *control* in the batteries chrome — future (§12).
- **Decoding into caller-provided memory** — the browser forbids it (§5); the
  feasible, useful version is caller-owned *present* textures, which Mode B delivers.
- Decoding straight to a GPU texture bypassing `CanvasImageSource` — a measured
  optimization, not v1 (§14).
- Any wire-protocol change. Nothing here touches `protocol.py` or the fixtures.

---

## 4. The layering

```
 WebSocket  ─►  decode                ─►  DisplaySurface (backend)     ─►  pixels
 (worker)       videoDecode/imageDecode    Canvas2D | WebGL2 | WebGPU
                produces a CanvasImageSource   Mode A: present({src,dst}) onto OUR canvas
                (VideoFrame | ImageBitmap)     Mode B: keep frame as a texture in YOUR context
                                                       → you compose it into your scene
                         ▲                             ▲
                         │                             │ {src rect (frame px), dst rect (backing px)}  [Mode A]
                    (unchanged)                        │ frame-as-texture handle                        [Mode B]
                                          Viewport policy  (viewport.ts + coordinator)
                                          fit today; zoom/pan/crop later (roadmap item 2)
                                          also owns the event inverse-map (backingToFrame)
```

Three responsibilities, cleanly separated:

- **Decode** (unchanged): bytes → a `CanvasImageSource` + its display size.
- **DisplaySurface** (new seam): keep the current frame in a *backend-native* buffer,
  and either present a `{src,dst}` region of it (Mode A) or hand it to the caller as a
  texture (Mode B). Presentation-free.
- **Viewport policy** (`viewport.ts`, generalized): compute `{src,dst}` from (frame
  size, backing size, fit, zoom, pan) and the inverse for events. The only place
  presentation lives (Mode A). Mode B has no viewport — the caller's scene decides.

The `Renderer` class becomes a thin coordinator: hold a `DisplaySurface`, own the
retained-frame lifecycle, and (Mode A) translate viewport state → `present()`.

---

## 5. The decode memory model — what the browser lets you own

This reframes the maintainer's instinct (*"the caller provides the memory frames
decode into"*). That specific model is **not available**, but its useful cousin is.

**WebCodecs owns decode memory.** You cannot hand `VideoDecoder` a buffer or texture to
decode into; there is no decode-into-caller-memory API. The decoder allocates, and its
`output` callback yields a **`VideoFrame` — an opaque handle** whose pixels may live in
a GPU texture / platform video surface (IOSurface, DXGI, `GpuMemoryBuffer`) or in
system memory, usually **YUV (NV12/I420)**. You generally cannot choose or even query
which.

The *only* operation where you provide the destination memory is:

- **`videoFrame.copyTo(hostArrayBuffer, opts)`** — copies pixels into an `ArrayBuffer`
  you own. But it targets **host (CPU) memory**, and if the frame is GPU-backed it is a
  **readback** — the opposite of what GPU compositing wants.

Everything else a `VideoFrame` supports is a *source-for-upload*, not a
*destination-you-provide*: `drawImage(frame)`, `gl.texImage2D/texSubImage2D(…, frame)`,
`copyExternalImageToTexture({source:frame})`, `importExternalTexture({source:frame})`,
`createImageBitmap(frame)`. So the correct reframing is:

> Not **"provide the memory frames decode into"** (impossible) but **"own, or
> participate in, the texture the frame is *presented* into"** (native, and exactly
> what client-side compositing needs).

### 5.1 Per-backend upload reality

| | **Canvas2D (`drawImage`)** | **WebGL2** | **WebGPU** |
|---|---|---|---|
| Frame → surface | `ctx.drawImage(frame, …)` | `texSubImage2D(yourTex, frame)` | `importExternalTexture({source:frame})` **or** `copyExternalImageToTexture(frame, yourTex)` |
| Who owns the dest | the 2D canvas (managed) | **you** (you allocate the `WebGLTexture`) | external: nobody (transient); copy: **you** own the `GPUTexture` |
| Zero-copy? | GPU blit, no CPU readback — but no shader access | GPU-side upload, usually no CPU readback; **not guaranteed literally zero-copy** | `importExternalTexture` is the **designed zero-copy sample path**; the copy variant is a GPU copy |
| YUV→RGB | during blit | during upload (into your RGBA texture) | in-sampler (external) / during copy |
| Composite model | 2D ops only (`globalAlpha`, layered `drawImage`) | **full shader scene** — frame is one texture among many | **full shader scene** |
| Retainable (hold across idle/resize)? | yes (it's your canvas) | yes (persistent texture) | **external: no** (expires end of task); copy: yes |

Reading the table:

- **Canvas2D** can composite, but with 2D operations only — no custom shaders, no 3D.
  Wrong host for "a WebGL GUI over the frame."
- **WebGL2 is the sweet spot for the caller-owned-texture model.** Allocate a
  `WebGLTexture` once; each frame `texSubImage2D(yourTexture, videoFrame)`; the browser
  does YUV→RGB into your RGBA texture during the upload. Now the frame is *just another
  texture in your scene*. Literal zero-copy isn't contractual (treat it as a fast GPU
  upload), but there's no CPU roundtrip in the good case. **Headless-testable today**
  (SwiftShader).
- **WebGPU has the only true zero-copy sample path**: `importExternalTexture` returns a
  `GPUExternalTexture` your shader samples directly (`textureSampleBaseClampToEdge`),
  YUV handled in-sampler, importing the platform surface with no copy — **but it is
  transient** (expires when control returns to the browser; re-import every frame; you
  **cannot store or retain it**). For a persistent RGBA texture you own,
  `copyExternalImageToTexture` is the path, and that is a GPU copy.

---

## 6. The `DisplaySurface` interface — two access modes

Recommendation: **a narrow, present-oriented contract for Mode A, plus a first-class
frame-as-texture contract for Mode B.** (The earlier draft's `native()` "escape hatch"
becomes Mode B proper — the compositing scenario deserves better than a hatch.)

### 6.1 Mode A — managed present (the simple viewer)

```ts
export type SurfaceKind = "2d" | "webgl" | "webgpu";
export interface Rect { x: number; y: number; w: number; h: number }
/** Sample this region of the current frame into this region of the backing store.
 *  Subsumes fit (whole-frame src) AND zoom/pan/crop (a sub-rect src). */
export interface PresentGeometry { src: Rect; dst: Rect }

export interface DisplaySurface {
  readonly kind: SurfaceKind;
  setColorSpace(space: PredefinedColorSpace): void;
  /** Resize the backing store (device px). Clears; caller re-presents. */
  resize(backingW: number, backingH: number): void;
  /** Adopt a new decoded frame as the retained current frame. Copies synchronously
   *  (2D: drawImage into a shadow canvas; GL: texSubImage2D; WebGPU: copy or import)
   *  because the caller closes `src` right after. `frameW/H` = display size. */
  setFrame(src: CanvasImageSource, frameW: number, frameH: number): void;
  /** Present the retained frame with an explicit geometry. No fit/zoom knowledge.
   *  Cheap + idempotent — safe to call every animation frame during a gesture. */
  present(geom: PresentGeometry, background: string): void;
  readPixels(): ImageData;
  toBlob(type?: string): Promise<Blob>;
  dispose(): void;
}
```

Two things make this work: `present` takes a **source rect** (generalizing today's
whole-frame `frameDestRect`, so one primitive serves fit *and* zoom/pan/crop — Canvas2D
uses the 9-arg `drawImage`, WebGL texcoords + `gl.viewport`, WebGPU a sampler UV
transform + viewport/scissor); and **retention is backend-native** — `setFrame` copies
into a buffer the backend owns and `present` reads from *that*, never from the (already
closed) `VideoFrame`. `viewport.ts` grows a `presentGeometry(state): {src,dst}` with
`backingToFrame` as its exact inverse.

### 6.2 Mode B — frame-as-texture (composite into your own scene)

Mode B inverts ownership: **the caller brings the context and the render loop; the
`DisplaySurface` only keeps the current frame uploaded as a texture in that context.**
This is the technically-correct version of "the caller provides the texture."

```ts
/** Created against the CALLER's GL/WebGPU context. It uploads each decoded frame into
 *  a texture the caller then samples in its own passes. It draws nothing itself. */
export interface FrameTextureSource {
  readonly kind: "webgl" | "webgpu";
  setColorSpace(space: PredefinedColorSpace): void;
  setFrame(src: CanvasImageSource, frameW: number, frameH: number): void;
  /** Current frame size (for UV math in the caller's shader). */
  readonly frameW: number;
  readonly frameH: number;
  dispose(): void;
}

export interface WebglFrameTextureSource extends FrameTextureSource {
  kind: "webgl";
  /** A GL texture in the caller's context, updated by setFrame. Null before frame 1. */
  readonly texture: WebGLTexture | null;
}
export interface WebgpuFrameTextureSource extends FrameTextureSource {
  kind: "webgpu";
  /** Import the current frame as a transient external texture — call INSIDE the render
   *  pass that samples it; do not retain (§5). Falls back to a copied GPUTexture when a
   *  persistent handle is requested. */
  importCurrentFrame(): GPUExternalTexture | null;
  /** A persistent RGBA copy the caller may retain (costs a GPU copy per frame). */
  currentTexture(): GPUTexture | null;
}
```

**Worked example — frame + minimap + GUI overlay, all client-side (WebGL2).** The app
owns a WebGL2 canvas and its own rAF loop:

```
const ft = createFrameTextureSource(gl);       // Mode B, caller's gl
// decode worker transfers each VideoFrame here → ft.setFrame(frame, w, h); frame.close();

function frame() {                             // the app's own render loop
  // pass 1: the framebuffer stream, framed by the viewport transform
  drawQuad(gl, ft.texture, viewportUV, fullViewport);
  // pass 2: a corner minimap sampling the SAME texture at full extent
  drawQuad(gl, ft.texture, fullUV, cornerRect);
  // pass 3: the client-generated GUI overlay (own geometry/textures), blended on top
  drawGui(gl, guiState);
  requestAnimationFrame(frame);
}
```

The library's job shrinks to *"bytes off the socket → a live texture in your
context."* No `present`, no fit — the caller composites. This is the scenario the
maintainer described (a windowed frame, a lower-corner overview map, a hardware GUI
overlay blended over the image), and it is why the GPU backends are worth building.

### 6.3 The zero-copy ↔ retention tension (design note)

Mode B pulls two goals against each other:

- **Zero-copy sampling** of the live frame wants the transient handle (WebGPU
  `importExternalTexture`; the WebGL upload).
- **Retention** — holding the last frame when decode is idle, or across a resize — needs
  a frame that *persists*, which the transient external texture cannot do; only a
  copied-into-your-texture can.

So: **external-texture for live compositing; copy-into-your-texture when you must
hold it.** The `WebgpuFrameTextureSource` exposes both (`importCurrentFrame` vs
`currentTexture`) and the caller picks per need. WebGL2 sidesteps the dilemma — its
uploaded texture is both reasonably cheap *and* retainable. This same tension drives
the WebGPU Mode-A carve-out in §8.

---

## 7. The three backends (Mode A mechanics)

| Concern | **Canvas2D** (floor) | **WebGL2** | **WebGPU** |
|---|---|---|---|
| Context | `getContext("2d",{colorSpace})` | `getContext("webgl2")` | `getContext("webgpu")` + `configure()` |
| `setFrame` upload | `drawImage` into a shadow `OffscreenCanvas` | `texSubImage2D(…, src)` into a `TEXTURE_2D` | `copyExternalImageToTexture` into a `GPUTexture` (Mode A retains → copy, not import) |
| `present` | 9-arg `drawImage(shadow, src…, dst…)` | textured-quad; UV=src/frame, `gl.viewport`=dst | render pass; sampler UV=src/frame, viewport=dst |
| `resize` | set `canvas.width/height` | set `canvas.width/height` + `gl.viewport` | `context.configure()` (resizes swapchain) |
| Retained buffer survives resize? | yes | yes | yes (texture) — but see §8 carve-out |
| Loss mode | — | `webglcontextlost` | `device.lost` |

**Selection.** Mirror the capability probe (`capabilities.ts`, `isCodecSupported`): a
`probeSurface()` that tries the *requested* backend then falls back — WebGPU
(`navigator.gpu?.requestAdapter()` succeeds) → WebGL2 (`getContext("webgl2")` non-null)
→ Canvas2D (always). Default **Canvas2D**: per `CLAUDE.md`'s "measure first,"
`drawImage` of a hardware `VideoFrame` is already fast, so a GPU path is opt-in / auto-
only-when-it-pays. `RfbViewOptions.surface?: "auto" | "2d" | "webgl" | "webgpu"`
(default `"2d"` initially, `"auto"` once the GL path is proven), like `imageOnly`.

**`VideoFrame` lifecycle.** All uploads are synchronous copies (`drawImage` /
`texSubImage2D` / `copyExternalImageToTexture` read the source before returning), so the
decode path keeps closing the `VideoFrame` right after `setFrame` — the
[client_decode_resilience](../completed/client_decode_resilience.md) invariant is
preserved. (`importExternalTexture`, being a live view, is the exception — it is a
Mode-B-only, in-pass call; Mode A always copies.)

### 7.1 Orientation is source-type-dependent (a real gotcha the harness caught)

The three real frame types — **ImageBitmap** (image path), **VideoFrame** (video path),
and OffscreenCanvas (internal/test) — do **not** share upload orientation semantics, and
Canvas2D is the only backend where it's a non-issue (`drawImage` is upright for all). The
GPU backends needed care, and the streaming quadrant test can't catch a flip (a vertical
flip aliases to a palette rotation — §11), so this was verified with an **asymmetric
controlled frame across every source type**:

- **WebGL: `UNPACK_FLIP_Y_WEBGL` is unreliable.** It is honored for a VideoFrame/canvas
  but **ignored for an ImageBitmap** (whose orientation is fixed at creation). So no
  single `FLIP_Y` value orients all types. The fix: **never use `UNPACK_FLIP_Y`** (all
  sources upload frame-row-0 at `t=0`) and **flip V in the present shader** — one mapping,
  correct for every type. (This also fixed a *latent P2 bug*: with `FLIP_Y=true` the real
  ImageBitmap image path rendered upside-down, hidden because the first harness used an
  OffscreenCanvas source and the streaming test uses flip-blind `matchedRotation`.)
- **WebGPU: `copyExternalImageToTexture` only reads a VideoFrame on software adapters.**
  On Dawn/SwiftShader it silently copies **black** from an ImageBitmap or canvas (works
  from a VideoFrame). The fix: **normalize non-VideoFrame sources through a
  `new VideoFrame(src)`** before the copy (cheap; the image path is low-rate). WebGPU's
  texture origin is top-left and `copyExternalImageToTexture` keeps the source upright, so
  no shader flip is needed there.
- **readback** flips too: `gl.readPixels` is bottom-up (rows reversed into top-down
  `ImageData`); WebGPU `copyTextureToBuffer` needs 256-byte row padding un-packed.

The lesson encoded in the tests: **conformance must exercise the real source types**
(ImageBitmap *and* VideoFrame), not a stand-in, or orientation bugs hide.

---

## 8. Resize resilience across backends — and the WebGPU carve-out

The invariant from today's `renderer.ts`: **a display-only resize or fit change
repaints the last frame in place — no decoder reset, no keyframe request, no blank
flash.** Today that is `lastFrame` (an `OffscreenCanvas`) + `paint()`.

Generalized (Mode A): the retained buffer is backend-native and `present()` re-samples
it, so resize is uniformly *"`resize()` the backing store, recompute geometry,
`present()` again."* Backends differ only in the upload primitive, the resize primitive
(set `width/height` vs `context.configure()`), and the **loss mode** (`webglcontextlost`
/ `device.lost` — the retained GPU texture is gone until the next frame).

**The carve-out, refined by what the implementation actually needed.** The maintainer
granted permission to make WebGPU Mode A *less* robust across resize (accept a transient +
use the status overlay) rather than pay complexity. In implementation it turned out
retention is **cheap on WebGPU too**: Mode A already uploads each frame into a persistent
RGBA `GPUTexture` via `copyExternalImageToTexture` (the reliable cross-implementation
path, §7.1), and that texture **survives a swapchain `configure()`** — so resize
re-presents from it cleanly, exactly like WebGL, with no per-frame cost beyond the upload
Mode A does anyway. So:

- **Canvas2D, WebGL2, and WebGPU Mode A all keep full retention** — resize stays smooth on
  every backend; no blank gap, no overlay needed for the routine case. The carve-out's
  permission wasn't needed for resize because the cheap-and-robust path exists.
- **The genuinely unrecoverable case is `device.lost`** — the retained `GPUTexture` is
  gone until the next decoded frame. Policy (a) from §7 applies (blank until the next
  frame; rare). The **transient-overlay** mechanism (a `"transient"` `StatusKind` in
  `statusOverlay.ts::computeStatus`, reusing the existing scrim) is reserved for polishing
  *that* case and is **not built now** — a documented future refinement, not a blocker.

Net: the intended simplification (don't over-engineer WebGPU resize) holds, but the
outcome is *better* than the original carve-out — WebGPU resize matches the other backends
for free, and the overlay is reserved for the truly rare device-loss transient.

---

## 9. Worker topology (where present/composite runs)

The `DisplaySurface`/`FrameTextureSource` seam makes topology a deployment choice,
because present is cheap and reads a retained buffer:

- **A. Single worker (today, default).** WS + decode + surface in the decode worker,
  which owns the transferred `OffscreenCanvas`. Zero cross-thread frame movement.
- **B. Decode worker + present/composite elsewhere.** The canvas/context is owned by
  whoever draws. To present on the **main thread** (compose the frame into the app's own
  WebGL/WebGPU scene — the Mode B case — or drive present from the app's rAF) or a
  **second worker**, the decode worker hands off the frame as a `Transferable`:
  **`VideoFrame` and `ImageBitmap` are both transferable** (`postMessage(msg, [frame])`
  — a handle move, not a pixel copy). The present/composite owner calls
  `setFrame`/`close()`.
- **C. Two workers.** Decode worker → present worker (owns the canvas), same transfer.

**WebGPU constraint:** `importExternalTexture` (and any GPU upload) must run on the
thread that owns the `GPUDevice`. So if compositing is on the main thread, the decode
worker must transfer the `VideoFrame` there (cheap) — a real constraint on Mode B
topology, not a blocker.

**Present loop.** Add an optional **rAF-driven present loop** (owned by the present
side): each animation frame, `present(currentGeometry)` re-samples the retained frame.
This makes pan/zoom smooth (the gesture mutates `geometry`; the loop redraws at display
refresh, independent of frame arrival) and costs nothing idle (early-out on unchanged
geometry). Decode still pushes latest-wins; the two cadences decouple. The single-worker
default can stay edge-triggered until the viewport (item 2) needs rAF.

None of this changes the wire or the push model — only *where the decoded handle is
drawn*.

---

## 10. How the viewport (roadmap item 2) plugs in

> **Landed (roadmap item 2).** The seam held exactly as predicted below — one refinement:
> zoom/pan are expressed as an **over-large `dst`** (a whole-frame `src`, a `dst` that can
> exceed the canvas), the same convention `cover` already used to show a cropped sub-rect,
> so every backend clips the overflow (Canvas2D `drawImage`, GL `viewport`, WebGPU
> clip-space) and no new draw code was needed. `frameDestRect`/`presentGeometry` became
> zoom/pan-aware, `backingToFrame` stayed its exact inverse, and the pure helpers
> (`zoomAround`, `panByBacking`, `centerOnFrame`, `presetFraming`, `clampZoom`) live beside
> them. Gestures + the imperative API live in `RemoteFramebufferView`; present is
> edge-triggered per gesture (re-present the retained frame), not an rAF loop — cheap enough
> for the single-worker default.

Proof the seam fits the next layer, not part of this one:

- Item 2's transform (crop rect + zoom + pan on top of fit) is *entirely* the
  `{src,dst}` `PresentGeometry`: fit and zoom/pan alike feed `presentGeometry`; the whole
  frame is the `src` and `dst = frameDestRect` carries the fit·zoom scale + centering + pan
  (over-large, the backend clips). "center on point" and 1:1 are presets computing the
  transform. `viewport.ts`'s `zoom`/`panX`/`panY` feed it.
- Event mapping stays correct for free: `backingToFrame` is the exact inverse of
  `frameDestRect`, so a click maps through whatever zoom/pan is current — the invariant
  the HiDPI bug violated, now covering zoom/pan too.
- Gestures live in `RemoteFramebufferView` (or the batteries chrome); they only mutate
  viewport state and re-present the retained frame. No backend or wire change.

So item 2 was "compute a richer `{src,dst}` and drive it with gestures" — no new draw
code, because the draw path is this layer. (Mode B apps do their own framing and don't
use item 2's viewport at all.)

---

## 11. Testability

The route the maintainer worried about *is* testable, because the hard part (pixels on a
real GPU context) reuses the existing harness:

1. **Pure unit (Vitest, `viewport.test.ts`).** `presentGeometry` / `backingToFrame`
   round-trip for fit today and zoom/pan later — DOM-free, backend-free. Correctness is
   *proven* here; backends only have to execute a `{src,dst}` faithfully.
2. **Backend conformance (Playwright).** The e2e already boots Chromium with **ANGLE
   SwiftShader** (`--use-gl=angle --use-angle=swiftshader`) and reads back canvas pixels
   vs `expectedQuadrantColor`. Parameterize that spec over `surface ∈ {2d, webgl}` and
   assert all backends produce the same quadrant colors within tolerance. **WebGL2 is
   available headless today** — no new infra.
3. **WebGPU, gated (verified feasible headless).** An empirical probe of the repo's
   Playwright Chromium confirmed WebGPU **does** run headless here, with caveats that
   shape the P5 spec:
   - The repo's existing GL args (`--use-gl=angle --use-angle=swiftshader`) alone yield
     `requestAdapter() === null` — pinning GL to SwiftShader suppresses the adapter. Add
     **`--enable-unsafe-webgpu`** (and `--use-webgpu-adapter=swiftshader` for a
     deterministic software adapter across dev/CI) in a **dedicated Playwright project**
     so the existing GL project is untouched. Linux CI likely also needs
     `--enable-features=Vulkan` (verify on the runner).
   - `navigator.gpu` is only exposed in a **secure context** — `about:blank`/`data:` URLs
     report it absent. The e2e must `page.goto` the localhost app first (its `baseURL`
     is `http://127.0.0.1:…`, a trustworthy origin), *then* probe.
   - `importExternalTexture`, `copyExternalImageToTexture`, and OffscreenCanvas
     `getContext("webgpu")` + `configure()` are all present on a working device.
   - Still **gate + skip** at runtime like the H.264 spec, so it runs where an adapter
     materializes and skips-with-log otherwise:
     `test.skip(!(await page.evaluate(async () => { const g = (navigator as any).gpu; try { return !!g && !!(await g.requestAdapter()); } catch { return false; } })), "no WebGPU adapter")`.
4. **Mode B.** A minimal WebGL2 harness that creates a `FrameTextureSource` against a
   test context, feeds one synthetic frame, samples `texture` into a target, and reads
   back the expected quadrant colors — proving the frame reaches a caller-owned texture.
5. **Resize resilience.** An e2e that resizes mid-stream and asserts the frame stays up
   (readback non-blank, no keyframe request logged) for Canvas2D/WebGL; for WebGPU,
   assert the **transient overlay** appears and clears (the §8 carve-out is a spec'd
   behavior, so it gets a test rather than being an untested blank).

The one honestly-hard-to-CI piece is WebGPU-on-real-hardware, gated/skipped, not
blocking — consistent with how the GPU encoder tier is verified.

---

## 12. The batteries backend-switch (shipped with roadmap item 2)

A batteries-tier control that switches the display methodology (2D / WebGL / WebGPU /
auto) at runtime — now `view.setSurface(kind)`, exposed as a backend selector in every
`<RemoteFramebuffer>` chrome (anywidget + React/Svelte/Solid) and the `pdum-rfb demo`.

**One correction to the original sketch.** "Tear down the old surface, build the new one,
re-`setFrame` the retained frame" is *not* possible on the same canvas: **a canvas's
context type is immutable** (a canvas that yielded `2d` can never yield `webgl2`), and the
retained frame lives inside the worker that owns the surface. So `setSurface` **rebuilds the
whole view** — it discards the (transferred, one-shot) canvas, creates a fresh one, spins up
a new worker with the new `surface` preference, and **reconnects the stream** (a brief
reconnect flash; the current fit/zoom/pan carry over via the init options). This means the
switch only works when the view **owns its canvas** (a container target, as the batteries
wrappers use) — a caller-provided `<canvas>` is already context-bound. The seam still made
it small: only the rebuild plumbing was new, not any draw code.

---

## 13. Phased plan

Each phase is independently shippable and leaves the tree green.

- **P1 ✅ — Extract the seam (pure refactor, Canvas2D only).** Defined `DisplaySurface`
  (`worker/displaySurface.ts`); today's 2D path is `Canvas2dSurface` (retention →
  `setFrame`, paint → `present`). `viewport.ts` gained `presentGeometry(): {src,dst}`
  with `backingToFrame` as its inverse; the whole-frame case reproduces today's letterbox
  exactly. `Renderer` is a thin coordinator. Pure refactor; all tests green.
- **P2 ✅ — WebGL2 Mode A + selection + conformance.** `WebglSurface`
  (`worker/webglSurface.ts`) + `createDisplaySurface` (`worker/surfaceFactory.ts`) + the
  `RfbViewOptions.surface` option (`"2d"` default, `"webgl"`/`"auto"` opt-in, graceful
  fallback) reported on `stats.surface`. Verified by a server-free controlled-input
  conformance harness (`surface-harness.html` + `tests/e2e/surface-conformance.spec.ts`:
  orientation via an asymmetric frame — the streaming quadrant test can't catch a flip —
  letterbox fill, and WebGL-vs-Canvas2D pixel-parity at 1:1) plus the real decode→WebGL
  streaming path (`surface-streaming.spec.ts`). A real GPU draw path, proven pixel-equal
  to 2D against headless SwiftShader WebGL2.
- **WebGPU Mode A ✅ — the third backend (pulled ahead of Mode B).** `WebgpuSurface`
  (`worker/webgpuSurface.ts`), an **async** `createDisplaySurface` (WebGPU device
  acquisition is async; the init handler guards the brief null-renderer gap), `rgba8unorm`
  for clean readback, full retention via a persistent texture (§8), the `chromium-webgpu`
  Playwright project (`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`, gated +
  skipped where no adapter), and `readPixels()` made async across the interface. Verified
  upright + pixel-equal to Canvas2D for ImageBitmap and VideoFrame. Added `@webgpu/types`.
- **P3+P4+P5(Mode B) ✅ — topology + frame-as-texture (shipped together).** A **dual-mode
  worker** (`mode: "present" | "feed"`) behind a `FrameSink` seam (`worker/frameSink.ts`):
  present mode drives a `Renderer`; feed mode uses a `TransferSink` that **transfers each
  decoded frame to the main thread** (frame ownership moves with the transfer; the decode
  pipeline no longer closes frames — the sink does). Public **`FrameTextureFeed`** binds to
  the caller's `gl` (WebGL2) or `device` (WebGPU) and uploads each frame into a texture:
  `WebglFrameTexture` exposes `.texture`; `WebgpuFrameTexture` exposes a persistent
  `currentTexture()` **and** a zero-copy `importCurrentFrame()` (`importExternalTexture`,
  holding the live VideoFrame). The caller drives its own rAF loop and composites the
  texture (the present-loop, on the caller's side — workers have no rAF). Verified by a
  Mode B conformance harness (caller composites the frame texture upright; ImageBitmap +
  VideoFrame; WebGL + WebGPU) and a `FrameTextureFeed` **streaming** e2e (worker→transfer→
  upload→sample). Orientation contract: the frame texture's UV origin is the frame
  top-left (§7.1).
- **(Viewport UI — now roadmap item 1) ✅.** Zoom/pan/crop `{src,dst}`, presets, gestures,
  event inverse-map, and the batteries **backend-switch** (§12, `setSurface`) — all on top
  of P1–P3, no new draw code. Verified: 24 viewport unit tests + zoom/pan and live-switch
  e2e across 2d/webgl/webgpu.
- **Future** — decode-straight-to-GPU-texture ingest if profiling shows the
  `CanvasImageSource` hop costs (measure first — the draw-path benchmark in §15 is the tool;
  it already shows the *present* side is negligible on every backend, so the open cost is the
  worker→main frame transfer, not the draw).

P1 alone is worth landing: it untangles `Renderer` and gives `viewport.ts` the
`{src,dst}` primitive — the actual blocker for item 2 — before any GPU backend exists.

---

## 14. Open questions

1. **Interface altitude.** Confirm the Mode A present-contract + first-class Mode B
   `FrameTextureSource` (§6) over a single unified interface. Recommendation: two
   interfaces — they have genuinely different ownership models.
2. **Default backend.** Ship `surface: "2d"` default, `"auto"` (prefer GPU) opt-in until
   conformance + a real workload show the GPU path wins? Recommendation: yes — "measure
   first."
3. **WebGPU Mode A retention** (§8). Confirm best-effort + transient overlay over paying
   for full retention. Recommendation: best-effort; it is a rare, self-healing event.
4. **Default present target.** Keep worker-present default, main-thread present opt-in
   (§9)? Recommendation: yes; most apps want the canvas off the main thread — except Mode
   B apps, which own the thread by definition.
5. **Mode B color management.** In Mode B the caller samples an RGBA (or external) texture
   in its own shaders — do we hand back the frame's `ColorSpace` (from `config`/headers)
   so the caller can convert correctly, or assume the upload already normalized to the
   canvas space? Recommendation: expose the descriptor; let the caller decide.
6. **How many retained frames?** One suffices for fit/zoom/pan. Ever want two (crossfade
   on resolution change, interpolation)? Recommendation: one for v1; the seam allows N.
7. **Where geometry is computed** when present runs on a different thread than the
   viewport policy — recompute `{src,dst}` on the present side from a small state struct,
   or send the rects? Recommendation: send the compact `ViewportState`, compute next to
   `present` (keeps `viewport.ts` the single geometry source).

---

## 15. Measurements (draw-path benchmark)

The "measure first" hunch behind the `"2d"` default (§7, open question #2) is now backed by
a repeatable, headless benchmark instead of intuition.

**Harness.** `widgets/bench-harness.html` + `widgets/demo/bench-harness.ts` — a server-free,
main-thread page (mirrors `surface-harness.ts`) that renders a **known, deterministic moving
frame sequence** (a rotating pool of distinct gradient + moving-box + speckle frames, so the
driver can't elide a redundant upload) through a chosen path and publishes timings on
`window.__bench`. Query params: `mode=A|B`, `surface=2d|webgl|webgpu` (Mode A),
`feed=webgl|webgpu` (Mode B), `source=videoframe|bitmap`, `frame=WxH`, `frames`, `warmup`.
Specs: `widgets/tests/e2e/bench.spec.ts` (chromium: Mode A `{2d, webgl}` + Mode B `{webgl}`)
and `widgets/tests/e2e/bench-webgpu.spec.ts` (the gated `chromium-webgpu` project: Mode A/B
`{webgpu}`). Run: `pnpm -C widgets e2e bench.spec.ts --project=chromium` and
`… bench-webgpu.spec.ts --project=chromium-webgpu`; the table is printed and attached to the
run.

**Metrics** (main-thread wall-clock, `performance.now()`): `submitMs` = time around the
draw calls (`setFrame`+`present` for Mode A; caller `upload`+composite for Mode B) — the CPU
cost to *submit* a frame; `createMs` = per-frame `VideoFrame` construction (context, kept
separate); `flushMs` = one final GPU drain (`readPixels` / `onSubmittedWorkDone`) after the
whole run, i.e. the deferred GPU/raster backlog; `gpuMs` = real render-pass time from a WebGPU
`timestamp-query` when the adapter exposes it (Mode B WebGPU), else `null`.

> **⚠️ SwiftShader caveat — read before quoting these.** The only headless GPU available in
> CI/agent sandboxes is **ANGLE/Dawn SwiftShader, a software rasteriser** (the WebGPU project
> pins `--use-webgpu-adapter=swiftshader`). The `flushMs`/`gpuMs` (GPU-execution) numbers below
> are therefore **NOT representative of real-GPU performance** — they measure a CPU emulation of
> a GPU. What *is* portable and meaningful is (a) the `submitMs` (main-thread) column, which is
> real CPU work regardless of the rasteriser, and (b) the harness + methodology. **Real-GPU
> throughput numbers come from a human running these specs on hardware.**

Measured here (Apple Silicon, headless Chromium/SwiftShader, 1280×720, VideoFrame source):

| path | backend | submit mean | submit p95 | create mean | GPU drain (amortized)¹ | gpuMs (timestamp) |
|---|---|---|---|---|---|---|
| Mode A | 2d | 0.036 ms | 0.10 ms | 0.001 ms | ~7.4 ms/frame | — (no timer) |
| Mode A | webgl | 0.032 ms | 0.10 ms | 0.004 ms | ~5.6 ms/frame | — (no timer) |
| Mode B | webgl | 0.021 ms | 0.10 ms | 0.006 ms | ~6.2 ms/frame | — (no timer) |
| Mode A | webgpu | 0.032 ms | 0.10 ms | 0.002 ms | ~9.1 ms/frame | `null` (Mode A pass internal) |
| Mode B | webgpu | 0.033 ms | 0.10 ms | 0.003 ms | ~9.6 ms/frame | **1.27 ms** (n=30, real query) |

¹ `flushMs ÷ (warmup+frames)`: a coarse per-frame proxy for the deferred **software-raster**
backlog — the caveat applies in full; do not read these as GPU cost.

**What it says (portable conclusions):**

- **Per-frame present cost on the main thread is negligible — and effectively equal — across
  all four backends** (`submit` median 0.000 ms, p95 ≤ 0.1 ms at 1280×720). Drawing a frame is
  a *command submission*; the pixel-moving is a deferred GPU/compositor blit. This is the
  concrete evidence for open question #2: **`"2d"` stays the default** — it adds no main-thread
  cost over the GPU tiers, and `drawImage` of a hardware `VideoFrame` is itself a GPU blit, so
  a GPU backend does not buy a cheaper *present*.
- **The reason to choose WebGL/WebGPU is therefore Mode B (frame-as-texture) compositing and
  future zoom/pan — not present speed.** The benchmark confirms the payoff isn't "a faster
  `drawImage`"; it's "the frame is a first-class texture in your scene" (§1, §6).
- **Mode B upload+composite is in the same negligible submit band as Mode A present**, so the
  "decode-straight-to-GPU-texture" open item (§13 Future) is not blocked by any *submit*-side
  overhead. The unmeasured piece is the **cross-thread `VideoFrame` transfer** (worker→main)
  Mode B requires; it is a handle move, not a pixel copy (§9), and belongs in a follow-up that
  times the transfer end-to-end under a real decode load.
- **The WebGPU `timestamp-query` path works** (Mode B reported a real 1.27 ms render-pass time
  even under SwiftShader), so the harness will yield genuine GPU-pass numbers on hardware
  without code changes — the honest GPU-vs-GPU comparison the "measure first" note asks for.

The absolute GPU/raster cost (the drain column) must be re-measured on real hardware; the
harness makes that a one-command run on any target.
