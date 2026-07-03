# Roadmap / What's Next

The image, CPU-H.264, GPU-NVENC (host + zero-copy CUDA + SDK), and Apple
VideoToolbox paths all work end-to-end and are verified headlessly (pytest +
Vitest + Playwright; the GPU tier runs weekly on real hardware). Multiple browser
clients, multiple named streams, still-after-settle, the ASGI/Starlette front-end,
adaptive quality/metrics, auto-reconnect, and the framework + notebook adapters are
all shipped. Those are done and no longer tracked here.

The **client display backend** — a pluggable draw path (Canvas2D / WebGL2 / WebGPU)
in both Mode A (managed present) and Mode B (frame-as-texture, `FrameTextureFeed`) —
also shipped and is verified end-to-end (29 e2e across two Playwright projects). Its
design notes live in the
**[client display backend proposal](proposals/active/client_display_backend.md)**;
the two follow-ups it left open (a batteries UI to switch backends, and *measuring*
which draw path actually pays) are folded into items 1 and 5 below.

What follows is the short list of things actually worth doing next. It is
deliberately not exhaustive. Each item carries a rough **benefit · difficulty** read
to help triage.

## 1. Core UI viewport (crop / zoom / pan) + a backend-switch chrome

_benefit: high · difficulty: moderate_

The UI layer built **on top of** the shipped display backend. This is **entirely a
client concern** — the server does not zoom and never needs to know the client's
zoom/pan. The publisher owns the framebuffer; the client decides how to fit that frame
into its canvas and where the viewer is looking, and does its own coordinate transforms
so input events map back to frame space. Keeping the transform on the client is the
whole point: one shared encoded stream, N viewers each framing it however they like, no
per-client server render.

Today the client's sizing is rigid — a small fixed set of fit modes. The work is to
make it **arbitrary**, and to give the batteries tier a control surface for it:

- **A general viewport transform** (crop rect + zoom + pan) rather than fixed fit. The
  geometry seam already exists: `viewport.ts` reserves `zoom`/`panX`/`panY` (identity
  today) and `backingToFrame`/`frameDestRect` already round-trip event coordinates, so
  gestures can drive zoom/pan without any wire change. It expresses the transform as the
  `{ src, dst }` present-geometry the backend already consumes (`presentGeometry`).
- **Simple named presets** on top of the general transform — `fit`, `cover`, `fill`,
  `1:1`, "center on point" — so the common cases stay one-liners.
- **Gestures** (wheel-zoom, drag-pan, pinch) that only mutate viewport state and let the
  present loop redraw — no new draw code, no wire change.
- **Batteries chrome for switching the display backend.** The display backend is already
  selectable (`surface: "2d" | "webgl" | "webgpu" | "auto"`, reported in `stats.surface`),
  but only programmatically. Add a control in the `<RemoteFramebuffer>` batteries chrome
  (and the anywidget chrome) — a sibling to the existing `capture PNG` button — to pick the
  backend live, plus zoom/fit controls. This is the "switch display methodology" UI the
  display-backend proposal deferred. Lives in the **batteries tier**, never the headless
  primitive.

**Expose it in the demo.** Swap the `pdum-rfb demo` viewer over to the batteries chrome
(the "Chromium batteries") so the backend selector + zoom/pan controls are visible there,
leaving the rest of the demo shell as is — the demo becomes the place we exercise the
chrome. See the **[display backend proposal](proposals/active/client_display_backend.md)**
(§9) for how the viewport and backend layers meet.

> **Status: shipped.** `viewport.ts` grew the general zoom/pan transform — `frameDestRect`
> scales/pans, `presentGeometry` returns the zoom/pan-aware `{src,dst}` the display backend
> consumes, and `backingToFrame` is its exact inverse so events stay correct under any
> zoom/pan — plus pure preset/gesture helpers (`presetFraming` for `fit`/`cover`/`fill`/
> `one-to-one`, `zoomAround`, `panByBacking`, `centerOnFrame`, `clampZoom`).
> `RemoteFramebufferView` gained the viewport API (`setViewport` / `zoomBy` / `applyPreset` /
> `resetView` / `getViewport`), opt-in gestures (`gestures: true` — wheel-zoom, middle/
> right-drag pan, pinch, re-presenting the retained frame with no wire traffic), and a
> **live backend switch** (`setSurface` — rebuilds the view, since a canvas context type is
> immutable). The **batteries chrome** (anywidget + React/Svelte/Solid, shared via `rfb-ui`)
> adds a backend selector + zoom controls next to `capture PNG`, and the `pdum-rfb demo`
> viewer exposes both. Verified: 24 viewport unit tests + zoom/pan present-correctness and
> live-switch e2e across all three backends (2d/webgl/webgpu). See the proposal §9/§12.

## 2. Resolution as an adaptive lever

_benefit: medium · difficulty: moderate_

`AdaptiveQualityController` (`adaptive.py`) has three levers — bitrate, fps, then
in-flight — but **not resolution**. In the push model the publisher owns the
framebuffer size, so resolution-scale adaptation was deliberately left to the render
loop. That's a real gap: on a congested link, dropping to a smaller encode is often
the best quality-per-bit move, and every client re-`configure()`s cleanly on a resize
already (the encoder rebuild + keyframe path is well-trodden).

Add a server-driven **downscale hint** (a fourth lever, or a `set_quality` field the
publisher can honor) so the loop can shrink the encoded frame under pressure and
recover when healthy — without hand-rolling it in every app. Because the publisher owns
resolution, the natural shape is a hint the render loop **reads off `poll_events()`**
(an event the controller emits under pressure), so the app opts in by honoring it,
symmetric with how input events already flow.

> **Status: landed.** `AdaptiveQualityController` gained a fourth lever —
> `QualityTarget.scale` (`min_scale`/`scale_step`), engaged only under *sustained*
> pressure once bitrate, fps, and in-flight are all floored, and recovered when healthy.
> Because the publisher owns the framebuffer size, the session can't apply it; instead it
> surfaces a typed **`DownscaleHint`** (`scale`, suggested even `width`/`height`) through
> `Display.poll_events()` — symmetric with how input events flow — that the render loop
> reads and honors by publishing a smaller frame (the encoder rebuild + browser
> re-`configure()` on resize is the existing path). The `Display` aggregates across
> viewers (the most-congested viewer's scale wins; it relaxes when that viewer recovers or
> leaves). Opt-in via `serve(adaptive=True)`. See `docs/guide_python.md` (Adaptive
> quality → Resolution as a fourth lever).

## 3. Record to MP4 (server-side tap + client-side batteries)

_benefit: high · difficulty: moderate_

A first-class "record what I'm publishing / viewing to an MP4" convenience. Today
producing a demo clip means hand-rolling a muxer around the publish loop; this should be
a one-liner. Two variants, deliberately symmetric — **ship the server tap first** (the
more broadly useful one for demos and headless capture):

- **Server-side, on the rendering interface.** A convenience on `Display` (e.g.
  `display.record("out.mp4")` → a context manager / handle with `.stop()`) that taps the
  same published-frame stream the sessions pull from and muxes it to a file — independent
  of any connected browser, so it works headless (demos, screenshots, CI artifacts,
  golden-frame capture). It **reuses the H.264 encoder** but muxes to a real MP4
  container. Note this is the one place AVCC/MP4 is correct: the wire invariant ("Annex B
  only, never route H.264 through an mp4 muxer") is about the *WebSocket* payload — a file
  recording wants exactly the AVCC-in-MP4 the wire forbids, via a separate PyAV mux path.
  Honor the real monotonic timestamps that already propagate source → encoder so variable
  cadence (sparse `still_after` scenes included) records with correct frame timing. The
  image transport can fall back to encoding stills into the same container.
- **Client-side, in the batteries wrappers.** Record exactly what the *viewer* sees —
  fit/zoom/pan and all — by `captureStream()`-ing the display canvas into a
  `MediaRecorder` (webm/mp4 per browser support), exposed as a `startRecording()` /
  `stopRecording(): Promise<Blob>` on `RemoteFramebufferView` and surfaced as a control in
  the `<RemoteFramebuffer>` batteries chrome. Lives in the batteries tier, not the headless
  primitive. A later refinement could mux the already-decoded `EncodedVideoChunk`s directly
  (no re-encode) when the container/codec line up.

> **Status: server-side tap landed; client-side batteries still open.** `Display.record("out.mp4")`
> ships — a started `Recording` handle (async context manager + `await rec.stop()`) that taps
> the same published-frame stream the viewer sessions pull from (a non-viewer `_taps` entry, so
> it never inflates `client_count` or the adaptive aggregation), encodes with **libx264**, and
> muxes to real **AVCC-in-MP4** via a *separate* PyAV path — never touching the Annex-B wire
> payload. It honors the real monotonic per-frame timestamps, so variable cadence (sparse
> `still_after` scenes included) records with correct VFR timing; RGB(A) host frames are
> supported (GPU frames are downloaded), and a mid-stream resize is scaled to the initial size.
> Gated on PyAV (`[h264]`) and lazy-imported. Lives in `pdum.rfb.recording`; verified by
> re-decoding the produced MP4 with PyAV. **Remaining:** the **client-side** `MediaRecorder`
> half (record exactly what the *viewer* sees — fit/zoom/pan — via `captureStream()`, surfaced
> as `startRecording()`/`stopRecording()` in the batteries chrome) is a separate follow-up in
> the widgets tier.

## 4. AV1 / HEVC codecs

_benefit: medium · difficulty: high · not scheduled_

Better compression at the same bitrate. The encoder registry + capability negotiation
already model this cleanly (`register_video_encoder`, `select_transport`), and the
browser decodes via WebCodecs. Two fronts: `av1_nvenc`/HEVC on the GPU paths, and a
CPU AV1 encoder (libaom / SVT-AV1) mirroring the libx264 backend. Gate the client on
`VideoDecoder.isConfigSupported` exactly like the H.264 path. Also unlocks the 10-bit /
HDR pipeline `types.ColorSpace` already models (`bit_depth`, `bt2020`/`pq`/`hlg` are
expressible but not yet wired through a 10-bit encode/decode chain). Parked for now.

## 5. Measure the client draw path (which backend actually pays)

_benefit: medium · difficulty: moderate_

The display backend ships three draw paths, but the honest guidance is still "Canvas2D
`drawImage` of a hardware `VideoFrame` is already fast, so it stays the default and GPU
is opt-in." Make that a **measured** claim rather than a hunch: a repeatable client
benchmark that renders a known stream through Canvas2D vs WebGL2 vs WebGPU and reports
per-frame present cost (and, where the platform allows, GPU time), so `surface: "auto"`
can choose on evidence and the docs can state when each pays.

Fold in the display-backend proposal's remaining **"decode-straight-to-GPU-texture"**
question: measure the Mode B path (worker decode → transfer → upload) against Mode A
present, and confirm whether the transfer/upload overhead is worth it for the
composite-into-your-own-scene use case. Output: numbers in the proposal + a note in the
JS guide.

## 6. Fix the marimo blank-viewer bug

_benefit: medium · difficulty: moderate_

`pdum-rfb marimo-demo` renders a **blank (black) viewer** even though the worker decodes
frames correctly (`capture()` readback shows real pixels) — an OffscreenCanvas→DOM
compositing failure specific to marimo (the widget lives in a shadow root; marimo appears
to reparent/re-render the subtree after `transferControlToOffscreen()`, severing the
placeholder→compositor link). Full investigation:
**[marimo rendering fix proposal](proposals/active/marimo_rendering_fix.md)**. The robust
fix candidate is a **main-thread present path** (worker → `ImageBitmap`/transfer → a
main-thread canvas the framework can freely reparent) — which the shipped Mode B topology
now makes cheap. After any notebook change, run `./scripts/test_notebooks.sh`.
