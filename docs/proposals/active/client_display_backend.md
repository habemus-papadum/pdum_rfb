# Client display backend: a pluggable draw path (Canvas2D / WebGL / WebGPU)

> **Status: proposal / design.** Splits roadmap item 1 (formerly "client-side
> viewport: crop, zoom, pan") into two layers: **(1)** this low-level *display
> backend* — the thing that turns a decoded frame into pixels, with the draw path
> (`drawImage` / WebGL / WebGPU) chosen by capability and no presentation policy of
> its own; and **(2)** the *core viewport UI* (crop/zoom/pan) built on top of it.
> This doc fleshes out layer 1 and defines the seam layer 2 plugs into. Two things
> shape the design that emerged in review: the browser's **decode memory model**
> (§5 — you cannot decode into memory you own) and the need to let a client
> **composite the frame into its own hardware scene**, not just present it (the Mode
> A / Mode B split, §6). See [roadmap](../../roadmap.md) items 1 and 2.

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

**The deliberate carve-out (new decision): WebGPU Mode A need not match Canvas2D/WebGL
retention robustness.** Holding a persistent RGBA `GPUTexture` and re-sampling it across
a swapchain `configure()` (and across `device.lost`) is real complexity and per-frame
copy cost (§6.3), all to smooth an event — a display resize — that is **rare and
self-heals on the very next decoded frame** (typically <1 frame-time later; a resize
already forces a keyframe on the match-client path). That trade is not worth paying on
the WebGPU path. Instead:

- **Canvas2D & WebGL2**: full retention, as today (cheap there — a canvas copy / a
  texture that already survives resize). No regression.
- **WebGPU (Mode A)**: retention is **best-effort**. If the retained frame isn't cheaply
  available across the reconfigure, the surface may briefly show the `background` (or a
  hold of the prior swapchain image) rather than a re-sampled frame, and it signals a
  **transient state** the existing status overlay renders — a brief indicator instead of
  a mysterious flash. Concretely: add a `"transient"` (or reuse a busy) `StatusKind` in
  `statusOverlay.ts::computeStatus` that a surface can raise for the sub-frame gap, so
  `RemoteFramebufferView` shows the same lightweight scrim it already uses for connect/
  reconnect. No new machinery — the overlay, `computeStatus`, and the state plumbing all
  exist; the surface just gets a way to raise "recovering, one moment."

This keeps the WebGPU backend lean (its reason to exist is Mode B zero-copy
compositing, not Mode A polish) and moves the cost of a rare event from *every frame's
code path* to *an occasional overlay blink*. Documented as an explicit, intended
difference between backends, not a bug.

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

Proof the seam fits the next layer, not part of this one:

- Item 2's transform (crop rect + zoom + pan on top of fit) is *entirely* the
  `{src,dst}` `PresentGeometry`: fit picks `src = whole frame`; zoom/pan pick a sub-
  `src`; "center on point" and 1:1 are presets computing `src`. `viewport.ts`'s reserved
  `zoom`/`panX`/`panY` feed `presentGeometry`.
- Event mapping stays correct for free: `backingToFrame` is the exact inverse of
  `presentGeometry`, so a click maps through whatever src/dst is current — the invariant
  the HiDPI bug violated, now covering zoom/pan too.
- Gestures live in `RemoteFramebufferView` (or the batteries chrome); they only mutate
  viewport state and let the present loop redraw. No backend or wire change.

So item 2 is "compute a richer `{src,dst}` and drive it with gestures" — no new draw
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
3. **WebGPU, gated.** Headless WebGPU (Dawn/SwiftShader) needs flags
   (`--enable-unsafe-webgpu`, `--use-webgpu-adapter=swiftshader`) and may be absent; gate
   the WebGPU spec on `navigator.gpu?.requestAdapter()` exactly like the H.264 spec gates
   on `isConfigSupported`, and **skip** where unavailable.
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

## 12. The batteries backend-switch (future, noted for completeness)

A batteries-tier control that switches the display methodology (image / WebGL / WebGPU)
at runtime is *out of scope for items 1 and 2*. It drops in later as a control in the
`<RemoteFramebuffer>` chrome that calls `view.setSurface(kind)` — tear down the old
surface, build the new one, re-`setFrame` the retained frame. The seam is what makes
that small.

---

## 13. Phased plan

Each phase is independently shippable and leaves the tree green.

- **P1 — Extract the seam (pure refactor, Canvas2D only).** Define `DisplaySurface`;
  make today's 2D `Renderer` implement it (retention → `setFrame`, paint → `present`).
  Generalize `viewport.ts` to `presentGeometry(): {src,dst}` with `backingToFrame` as
  its inverse; the whole-frame case reproduces today's letterbox exactly. No behavior
  change; existing tests stay green. Delivers the seam that unblocks item 2.
- **P2 — WebGL2 Mode A + selection + conformance.** WebGL2 `DisplaySurface`;
  `probeSurface()` + the `surface` option (`drawImage` stays the floor); the backend-
  parameterized readback e2e (§11.2) and the resize-resilience e2e (§11.5). A real GPU
  draw path, proven pixel-equal to 2D.
- **P3 — Topology + present loop.** The optional rAF present loop and the present-owner
  handoff (transfer `VideoFrame`/`ImageBitmap`). Decoupled present cadence — the
  prerequisite for smooth item-2 gestures — no wire change.
- **P4 — WebGL2 Mode B (frame-as-texture).** `FrameTextureSource` against a caller's
  context; the Mode B harness (§11.4); the minimap+overlay example. Delivers client-side
  compositing on the broadly-supported backend.
- **P5 — WebGPU (both modes) + the §8 carve-out.** WebGPU `DisplaySurface` (Mode A,
  best-effort retention + the transient overlay state) and `WebgpuFrameTextureSource`
  (Mode B, `importExternalTexture` zero-copy sample); gated conformance (§11.3). Delivers
  the true zero-copy compositing path where the platform supports it.
- **(Roadmap item 2) — viewport UI.** Zoom/pan/crop `{src,dst}`, presets, gestures,
  event inverse-map — all on top of P1–P3, no new draw code.
- **Future** — batteries backend-switch (§12); decode-straight-to-GPU-texture ingest if
  profiling shows the `CanvasImageSource` hop costs (measure first).

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
