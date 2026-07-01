# Sizing, Scaling, DPR & Color — design

Status: **proposal** (no code yet). Scope decided with the maintainer:

1. **Aspect-ratio-aware fit modes** on the client (default letterbox), with the
   coordinate contract corrected so clicks stay accurate under any fit.
2. **Server "match-client" resize** — an opt-in policy where the render stream
   follows the viewer's viewport instead of the publisher owning size unilaterally.
3. **Frame pixel ratio** — the publish API and the wire gain a notion of DPR on the
   *render* side, mirroring modern display practice.
4. **A color descriptor** — sRGB and **Display P3 (SDR, 8-bit)** as first-class,
   plus tagged YUV ingest. HDR (Rec.2100 PQ/HLG, 10-bit) is designed-for but not
   implemented.

Zoom/pan is **out of scope** for this iteration but the transform is designed so it
drops in later without a wire change.

This doc supersedes the sizing discussion in `docs/internals.md` and extends the
coordinate contract that `RemoteFramebufferView` established (see the HiDPI fix in
`widgets/src/worker/entry.ts` — the initial `set_viewport` handshake).

---

## 1. Where we are today

Three sizes exist and **nothing ties them together**:

| Size | Owned by | Source of truth |
|---|---|---|
| **Stream / framebuffer** (e.g. 1280×720) | publisher | `serve(w,h)`; every frame header carries `width`/`height` |
| **Canvas backing store** (device px) | client | `computeBackingSize(cssW, cssH, dpr)` = CSS × DPR, capped by `maxBackingDimension` |
| **Canvas CSS box** (layout px) | page CSS | `#stage { width; height }` |

The decoded frame is painted with a single call in `widgets/src/worker/renderer.ts`:

```js
this.ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height); // stretch-to-fill
```

Consequences:

- **No aspect-ratio preservation.** X and Y scale independently. The demo streams
  1280×720 (16:9) into a 640×480 (4:3) `#stage`, so it is *currently distorted*.
- **Client resize** (`ResizeObserver`) just recomputes the backing store, sends
  `set_viewport`, forces a keyframe, and re-stretches the same stream into the new
  box. See `RemoteFramebufferView.observeResize()`.
- **The stream *can* resize dynamically** end-to-end — frame headers carry
  `width`/`height`, encoders rebuild + force a keyframe on a size change, and the
  client `VideoDecoder` reconfigures when `codedWidth/Height` change
  (`videoDecode.ts::ensureDecoder`). But it is **publisher-initiated**: in a shared
  `Display`, `set_viewport` is explicitly *informational only*
  (`display.py::_ClientFeed.handle_event`) — recorded as the client's `viewport`
  tuple, never acted on.
- **Coordinates.** Today the client sends **logical CSS** coordinates; the publisher
  maps CSS→framebuffer with an *independent* X/Y scale (paint demo `_to_pixels`).
  That only happens to be correct for `fill` mode. There is no DPR or color notion on
  the frame side.

---

## 2. Goals & non-goals

**Goals**

- Correct-by-default rendering: preserve aspect ratio out of the box.
- Resize works from **either** end (client window resize; publisher re-render).
- Pluggable strategy when aspect ratios disagree: `fill` / `contain` / `cover`.
- A single **viewport transform** that both drawing *and* event mapping use, so
  clicks are always accurate (this is the invariant the HiDPI bug violated).
- A frame-side **pixel ratio** so a publisher can render at device resolution and the
  client displays at the intended logical size.
- A small, explicit **color descriptor** (sRGB / Display P3 SDR), forward-compatible
  with HDR.

**Non-goals (this iteration)**

- Client zoom/pan (designed-for, not built).
- HDR / 10-bit encode + decode (descriptor carries the fields; no pipeline).
- Per-client independent render sizes in a multi-viewer shared display (match-client
  is a single-authority policy; see §6.4).
- Arbitrary ICC color management. Only display-referred spaces the browser and the
  codecs natively signal.

---

## 3. The coordinate contract (decided: client computes the mapping)

**Decision:** the client owns the full transform stack and reports events in
**physical framebuffer pixels**, and *also* carries the frame `pixel_ratio` on each
pointer/wheel event so the publisher can derive logical coordinates when it wants.

Why the client, not the server: only the client knows the fit mode, the DPR, and
(later) zoom/pan. Pushing that state to the server is chatty and racy; computing the
inverse transform locally is atomic. This also makes the publisher's job trivial —
it receives pixels that index straight into the published array.

### 3.1 The transform (single source of truth)

A pure module `widgets/src/viewport.ts` (unit-tested, DOM-free) is the *only* place
the frame↔canvas geometry lives. Both `renderer.draw()` and the event path call it.

```ts
export type FitMode = "fill" | "contain" | "cover";

export interface ViewportState {
  frameW: number;  frameH: number;   // stream coded size (from the decoded frame)
  backingW: number; backingH: number; // canvas device pixels
  fit: FitMode;
  // Reserved for a future iteration; identity for now:
  zoom: number;    // 1 = fit exactly
  panX: number; panY: number; // device px, applied after fit
}

/** Where the frame is drawn inside the backing store (device px). For `cover`
 *  the rect exceeds the canvas and is clipped; for `contain` it is letterboxed. */
export function frameDestRect(v: ViewportState): { dx: number; dy: number; dw: number; dh: number };

/** Inverse map: a backing-store point -> frame pixels, with an `inside` flag that
 *  is false in letterbox padding (so the publisher can ignore out-of-frame clicks). */
export function backingToFrame(v: ViewportState, bx: number, by: number): { x: number; y: number; inside: boolean };
```

Fit math (SDR, no zoom/pan):

```
sx = backingW / frameW,  sy = backingH / frameH
fill    : scaleX = sx,            scaleY = sy            (independent — today's behavior)
contain : scaleX = scaleY = min(sx, sy)                 (letterbox; pad the excess)
cover   : scaleX = scaleY = max(sx, sy)                 (crop the excess)
dw = frameW*scaleX ; dh = frameH*scaleY
dx = (backingW - dw)/2 ; dy = (backingH - dh)/2         (centered)
```

Inverse (used for events):

```
fx = (bx - dx) / scaleX
fy = (by - dy) / scaleY
inside = 0 <= fx < frameW && 0 <= fy < frameH
```

### 3.2 Event flow after the change

Events still arrive on the **main thread** (`RemoteFramebufferView.onPointer`) in CSS
coordinates relative to the canvas, and are posted to the worker unchanged. The
**worker** — which owns the renderer, the current frame size, `pixelRatio`, and the
fit mode — performs the mapping just before `send()`:

```
css_x, css_y                    (from the DOM event, relative to the canvas)
→ backing: bx = css_x * pixelRatio, by = css_y * pixelRatio   (pixelRatio = effective ratio, honors maxBackingDimension cap)
→ frame:   {x, y, inside} = backingToFrame(state, bx, by)
→ send {type:"event", event:{... x, y, inside, pixel_ratio: framePixelRatio}}
```

`x`/`y` are **physical framebuffer pixels** (0..width-1). `pixel_ratio` is the
frame's render DPR (§5). `inside=false` lets a publisher discard clicks that fall in
letterbox bars (or clamp them — publisher's choice).

Wheel events map their **position** the same way; `dx`/`dy` scroll deltas stay in the
event's own pixel units (publisher-defined semantics), unchanged.

### 3.3 Server-side simplification

`_to_pixels` in the paint demo goes away — incoming `x`/`y` already index the
framebuffer. The demo just clamps and rounds. The `set_viewport` handshake is **no
longer needed for coordinate correctness** (that responsibility moved to the client)
but is still required for the **match-client resize policy** (§6) and remains useful
telemetry.

> **Contract change / migration.** This flips the wire meaning of pointer/wheel
> `x`/`y` from *logical CSS* to *physical frame pixels*. Affected: the paint demo,
> `docs/internals.md`, the `guide_*` docs, and the events e2e
> (`widgets/tests/e2e/events.spec.ts`, which asserts CSS coords at dpr=1). A `config`
> field (`coords: "frame-pixels"`) lets a server detect new clients; pre-change
> clients (none shipped in the wild) would be detectable by its absence.

---

## 4. Fit modes — API surface

Client (`RfbViewOptions`):

```ts
fit?: "fill" | "contain" | "cover"; // default "contain"
background?: string;                // letterbox fill for `contain`; default "#000"
```

`renderer.draw(src, frameW, frameH)` becomes:

```
clear canvas to `background`
{dx,dy,dw,dh} = frameDestRect(state)
ctx.drawImage(src, dx, dy, dw, dh)   // contain: letterboxed; cover: overflow clipped by canvas bounds
```

The worker tracks the current frame size from the decoded frame (`VideoFrame`'s
`displayWidth/Height`, or `ImageBitmap`'s `width/height`) and feeds it into
`ViewportState` on every draw, so a mid-stream resolution change (§6) re-letterboxes
automatically.

Default is **`contain`**: correct-looking for any AR mismatch, no cropping, no
distortion. `fill` preserves today's behavior for anyone who wants it.

---

## 5. Frame pixel ratio (render-side DPR)

**Decision:** the publish API and the wire gain a frame `pixel_ratio`, so a frame can
declare "these N×M device pixels represent (N/ratio)×(M/ratio) logical pixels."

### 5.1 Semantics

`pixel_ratio` is **device pixels per logical pixel of the frame** (default `1.0`). It
is display intent, not a resample instruction: the pixels are delivered as-is; the
ratio tells the client the frame's *logical* size for fit and lets the publisher
interpret event coordinates (which carry the same ratio, §3.2). Two independent DPRs
now exist and compose cleanly:

- **client DPR** — canvas backing = CSS × client DPR (unchanged).
- **frame DPR** — frame logical size = frame pixels ÷ frame DPR.

Fit is computed in **logical** space so a 2× frame in a 1× window is displayed at half
the pixel size (sharp), not double. Concretely `contain` uses
`min(backingW / (frameW), backingH / (frameH))` but the *target* the publisher should
render for a crisp match-client stream is `cssSize × clientDPR` (§6).

### 5.2 API

```python
# additive, backward-compatible (default 1.0)
display.publish(frame, pixel_ratio=2.0)

# RawFrame gains a field:
@dataclass(slots=True)
class RawFrame:
    ...
    pixel_ratio: float = 1.0
```

Wire: `pixel_ratio` is added to the image/video binary-envelope headers
(`protocol.py::image_header`/`video_header`) and echoed to the client, which folds it
into `ViewportState.frameDpr`. Absent ⇒ `1.0` (old servers unaffected).

---

## 6. Server "match-client" resize policy

**Decision:** opt-in. Default stays **publisher-owns-size** (matches the "you own the
loop" mental model). With the policy on, `set_viewport` becomes *authoritative*: the
render stream follows the viewer.

### 6.1 Enabling

```python
display = await rfb.serve(1280, 720, resize_policy="match_client")
# resize_policy: "publisher" (default) | "match_client"
```

### 6.2 Mechanism

`set_viewport` already carries `pwidth/pheight` (backing = CSS × client DPR) and
`ratio`. With `match_client`, the `Display` records a **target size** and exposes it
to the render loop, which renders to that size on the next tick and `publish()`es it.
The existing invariants do the rest: fixed-resolution encoders rebuild and force a
keyframe on the size change; the client `VideoDecoder` reconfigures. No new mechanism
— we're just *acting on* a signal we already receive.

```python
# proposed Display surface
display.target_size   # -> (w, h) | None ; latest client backing size, or None
# render loop:
w, h = display.target_size or (display.width, display.height)
display.publish(render(state, w, h), pixel_ratio=display.target_ratio or 1.0)
```

Target defaults to the client **backing** size (`pwidth/pheight`) so the stream is
pixel-crisp; the publisher may divide by `ratio` to render logical + tag
`pixel_ratio` instead (cheaper, same on-screen size). Debounce (e.g. 100–150 ms) to
avoid a rebuild storm during a drag-resize; clamp to a `max_render_dimension` guard.

### 6.3 Interaction with fit modes

Under `match_client` the stream AR tracks the window, so `contain`/`cover`/`fill`
coincide (no letterbox) — fit modes matter in `publisher` mode. Coordinates remain
correct in both because the client always maps through the *current* frame size.

### 6.4 Multi-viewer ambiguity (open decision)

"Match the client" is ambiguous with several viewers on one `Display`. Options, in
increasing effort:

- **A. Last-writer-wins** (default): the most recent `set_viewport` sets the target;
  other viewers letterbox via their own fit. Simple; documented.
- **B. Primary viewer**: the first/pinned connection is authoritative.
- **C. Per-client render** (future): each `_ClientFeed` requests its own size and the
  publisher renders N sizes. Powerful, but breaks the single-latest-frame model — a
  separate project.

Recommend **A** now; leave B/C as future work.

---

## 7. Color descriptor

**Decision:** carry a small, explicit color descriptor. Implement **sRGB** and
**Display P3 (SDR, 8-bit)**; design the descriptor to be HDR-ready; support **tagged
YUV** ingest (an *encoding*, not a gamut).

### 7.1 The descriptor

Mirror the WebCodecs `VideoColorSpace` fields (the client consumes them directly) plus
a `full_range` flag and a `bit_depth` for the HDR future:

```python
@dataclass(slots=True)
class ColorSpace:
    primaries: Literal["bt709", "display-p3", "bt2020"]   # gamut
    transfer:  Literal["srgb", "bt709", "pq", "hlg", "linear"]
    matrix:    Literal["rgb", "bt709", "bt2020-ncl"]       # RGB vs YUV coupling
    full_range: bool = True
    bit_depth: int = 8
```

Presets:

| Name | primaries | transfer | matrix | notes |
|---|---|---|---|---|
| `srgb` (default) | bt709 | srgb | rgb (or bt709 for YUV) | today's implicit space |
| `display-p3` | display-p3 | srgb | bt709 | Apple wide-gamut SDR, 8-bit |
| `rec2100-pq` *(future)* | bt2020 | pq | bt2020-ncl | HDR, 10-bit — descriptor only |

`RawFrame` gains `color: ColorSpace = SRGB`. `display.publish(frame, color=...)`. The
upstream renderer is responsible for producing pixels **in** the declared space (the
library does not color-convert).

### 7.2 Carrying it through each path

- **Wire:** add `color` to the frame headers; add it to the `config` message so the
  client can pre-configure. Absent ⇒ `srgb` (old servers unaffected).
- **Client canvas:** create the `OffscreenCanvas` 2D context with
  `{ colorSpace: "display-p3" }` when the stream declares P3 (Chromium supports
  `display-p3` canvases). sRGB is the default and needs nothing.
- **Image path:** WebP/PNG can embed ICC/color chunks; Pillow can tag them. The
  `ImageBitmap` → canvas draw honors the canvas color space. This is the *easy* path —
  wide-gamut stills work with only descriptor plumbing.
- **Video path (the caveat you raised):** H.264 does **not** transport RGB/sRGB
  pixels; it transports **YUV** with **VUI signaling** — `colour_primaries`,
  `transfer_characteristics`, `matrix_coefficients`, `video_full_range_flag`. So
  "sRGB over H.264" is really "YUV 4:2:0, primaries=BT.709, transfer=sRGB/BT.709,
  matrix=BT.709." Display P3 SDR is expressible: VUI `colour_primaries = 12`
  (Display P3 / SMPTE EG 432-1), `transfer = 13` (sRGB/IEC 61966-2-1) or `1` (BT.709),
  `matrix = 1` (BT.709). libx264 exposes these (`--colorprim smpte432 --transfer
  iec61966-2-1 --colormatrix bt709`) and PyAV surfaces them on the codec context.
  WebCodecs `VideoDecoder` returns a `VideoFrame` whose `colorSpace` reflects the VUI;
  drawing it to a `display-p3` canvas yields correct color.
  - **Chroma subsampling is lossy for gamut** at 4:2:0 — acceptable for SDR P3; note
    it. 4:4:4 (High 4:4:4 profile) is a future quality lever.
  - **NVENC / zero-copy NV12** already produces 8-bit YUV; it can be tagged with the
    same VUI. So P3 SDR rides the existing GPU path with only signaling added.

### 7.3 Why HDR is deferred (but designed-for)

Rec.2100 PQ/HLG needs **10-bit** (High 10 / HEVC Main10 / AV1) end to end: the encoder
(the zero-copy NV12 path assumes 8-bit → needs P010), the browser
`VideoDecoder.isConfigSupported` gate, and a 10-bit-capable canvas/compositor. The
`bit_depth`/`transfer` fields make it a clean future extension; no pipeline work now.

---

## 8. Wire protocol summary (all additive, all optional)

| Message | New field(s) | Default when absent |
|---|---|---|
| `config` (server→client) | `pixel_ratio`, `color`, `coords:"frame-pixels"` | 1.0 / sRGB / legacy CSS coords |
| image/video header (binary) | `pixel_ratio`, `color` | 1.0 / sRGB |
| `event` (client→server, pointer/wheel) | `x`,`y` now **frame pixels**; `+inside`, `+pixel_ratio` | — (gated by `config.coords`) |
| `set_viewport` (client→server) | *(unchanged)* — now honored under `match_client` | informational |

No change to the binary envelope framing, so the committed protocol **fixtures**
(`widgets/tests/fixtures/protocol/`) stay valid; only header *contents* gain optional
keys. Regenerate fixtures if we add header keys to the golden set.

---

## 9. Testing strategy

Extends the HiDPI work (which added a dpr=2 e2e because dpr≠1 was the untested axis).
The new axes are **fit mode**, **frame DPR**, and **color**.

1. **Vitest (pure) — `viewport.test.ts`.** `frameDestRect`/`backingToFrame` for
   `fill`/`contain`/`cover`, including: AR match (all three agree), 16:9→4:3 letterbox
   offsets, 4:3→16:9 crop, and round-trip `backingToFrame(frameDestRect)` identity.
   The letterbox `inside=false` case is the regression guard for out-of-frame clicks.
2. **Vitest — frame-DPR mapping.** A 2× frame in a 1× canvas maps a center click to
   the frame center; asserts fit is computed in logical space.
3. **Python — paint demo.** Replace the `_to_pixels` tests with: incoming coords are
   frame pixels (identity + clamp); a letterbox `inside=false` event is ignored.
4. **Python — match-client policy.** Feed a `set_viewport`, assert `display.target_size`
   updates and a subsequent `publish()` at that size produces a keyframe-forcing
   resize (reuse the session invariant tests).
5. **Playwright — the matrix that would have caught the original bug.** Parameterize
   `deviceScaleFactor ∈ {1, 2}` × `fit ∈ {contain, cover}` and assert, via
   `/recorded-events`, that a click at a known CSS point maps to the expected
   **frame** pixel (computed by the TS mirror of `frameDestRect`). Keep the dpr=2
   viewport-handshake guard from `hidpi.spec.ts`.
6. **Playwright — color.** Gate on `VideoDecoder.isConfigSupported` + canvas
   `display-p3` support; assert a P3 test frame reads back with the expected
   wide-gamut pixel (values outside the sRGB cube). Skips where unsupported (headless
   swiftshader may not do P3 — document the gate).

The cross-language contract (`render_test_pattern` / `expected_quadrant_color` and now
`frameDestRect`) must stay mirrored in Python and TS — that parity is the thing that
turns a geometry bug into a failing test.

---

## 10. Phased implementation plan

Each phase is independently shippable and testable.

- **P1 — Fit + client coordinate mapping (no wire size change).** `viewport.ts`,
  `renderer.draw` letterbox, worker event mapping to frame pixels, `fit` option,
  paint demo + tests, e2e matrix. Delivers the visible AR fix. *(Contract change to
  event coords lands here, gated by `config.coords`.)*
- **P2 — Frame pixel ratio.** `RawFrame.pixel_ratio`, `publish(pixel_ratio=)`, header +
  `config` plumbing, client folds `frameDpr` into fit, event `pixel_ratio` echo.
- **P3 — match-client resize.** `resize_policy`, `Display.target_size`, debounce +
  clamp, demo render loop honors it, session-invariant tests.
- **P4 — Color descriptor (sRGB + Display P3 SDR).** `ColorSpace`, presets,
  `publish(color=)`, header + `config`, `display-p3` canvas, VUI signaling on the CPU
  H.264 and NVENC paths, image-path tagging, color e2e.
- **Future** — client zoom/pan (client-only, no wire change); HDR/10-bit; 4:4:4;
  per-client render sizes (§6.4-C).

---

## 11. Open questions

1. **Multi-viewer match-client** (§6.4): confirm last-writer-wins for now.
2. **Letterbox out-of-frame clicks**: `inside=false` — should the default publisher
   behavior be *ignore* or *clamp to edge*? (Proposal: deliver with the flag; let the
   app decide; demos ignore.)
3. **match-client target**: render at client **backing** size (crisp, heavier) vs
   **logical** size + `pixel_ratio` tag (cheaper). Proposal: default logical+tag,
   opt into backing via a `crisp=True`-style knob.
4. **Config negotiation of `coords`**: do we ever need to support a legacy CSS-coords
   client, or is frame-pixels unconditional (no shipped clients to break)? Proposal:
   unconditional; `config.coords` is documentation/telemetry only.
5. **P3 through headless CI**: whether swiftshader/WebCodecs give us a testable P3
   path, or color stays a locally-verified + unit-tested contract with a gated e2e.
