# Roadmap / What's Next

The image, CPU-H.264, GPU-NVENC (host + zero-copy CUDA + SDK), and Apple
VideoToolbox paths all work end-to-end and are verified headlessly (pytest +
Vitest + Playwright; the GPU tier runs weekly on real hardware). Multiple browser
clients, multiple named streams, still-after-settle, the ASGI/Starlette front-end,
adaptive quality/metrics, auto-reconnect, and the framework + notebook adapters are
all shipped. Those are done and no longer tracked here.

What follows is the short list of things actually worth doing next. It is
deliberately not exhaustive. Each item carries a rough **benefit · difficulty** read
to help triage.

## 1. Client display backend: a pluggable draw path (Canvas2D / WebGL / WebGPU)

_benefit: high · difficulty: high_

The low-level layer *under* the viewport: the thing that turns a decoded frame into
pixels on the canvas, with **no presentation opinion of its own**. The draw path is a
`DisplaySurface` seam with three interchangeable backends — Canvas2D (the floor), WebGL2,
and WebGPU — selected by capability (`surface: "2d" | "webgl" | "webgpu" | "auto"`), each
just "sample this source region of the current frame into that destination region of
the canvas." No fit, no zoom, no pan at this layer; those are item 2.

> **Status: landed (both modes, all three backends).** **Mode A** (managed present):
> all three backends ship, verified pixel-equal to Canvas2D against a controlled
> asymmetric frame across both real source types (ImageBitmap + VideoFrame);
> `stats.surface` reports the active one. **Mode B** (frame-as-texture): `FrameTextureFeed`
> hands the decoded frame to the caller as a GPU texture in their own WebGL2/WebGPU
> context (a decode worker transfers frames to the main thread), so they composite it
> into their own hardware scene — minimap, overlay, blends. Verified end-to-end (29 e2e
> across two projects). Remaining follow-ups (batteries backend-switch UI, decode-straight-
> to-GPU-texture) are polish; see the proposal's phase tracker.

Why its own item: a compositing flow is useful for more than zoom/pan — the real
payoff of a GPU draw path is that the frame becomes a **first-class input to a
client-side hardware scene** (composite it with a minimap, a WebGL/WebGPU GUI overlay,
custom blends — all rendered on the client), not merely a faster `drawImage`. That is
lower-level functionality than the UI core and deserves to stand on its own. Note the
browser's decode memory model shapes this: you **cannot** decode into memory you own
(WebCodecs owns the `VideoFrame`), so the model is "own/participate in the *present*
texture," not "provide the decode buffer" — the proposal works this through per backend.

Two things make it real work rather than a mechanical swap: **(a)** the
retain-last-frame-and-repaint-on-resize resilience (trivial for the 2D copy today,
genuinely harder as a GL/WebGPU texture) — resolved by keeping full retention on
Canvas2D/WebGL and *deliberately relaxing it for WebGPU*, surfacing the rare, self-
healing resize gap through the existing status overlay rather than paying per-frame
cost; and **(b)** decoupling present cadence from decode cadence so a present loop can
redraw the retained frame at display refresh. **Measure first** — `drawImage` of a
hardware `VideoFrame` is already fast, so Canvas2D stays the default and a GPU path is
opt-in / auto-only-when-it-pays.

Design and phasing: **[client display backend proposal](proposals/active/client_display_backend.md)**.

## 2. Core UI viewport: crop, zoom, and pan

_benefit: high · difficulty: moderate_

The UI layer built **on top of** the display backend (item 1). This is **entirely a
client concern** — the server does not zoom and never needs to know the client's
zoom/pan. The publisher owns the framebuffer; the client decides how to fit that frame
into its canvas and where the viewer is looking, and does its own coordinate transforms
so input events map back to frame space. Keeping the transform on the client is the
whole point: one shared encoded stream, N viewers each framing it however they like, no
per-client server render.

Today the client's sizing is rigid — a small fixed set of fit modes. The work is to
make it **arbitrary**:

- A general viewport transform (crop rect + zoom + pan) rather than fixed fit. The
  geometry seam already exists: `viewport.ts` reserves `zoom`/`panX`/`panY` (identity
  today) and `backingToFrame`/`frameDestRect` already round-trip event coordinates, so
  gestures can drive zoom/pan without any wire change. It expresses the transform as the
  `{ src, dst }` present-geometry the item-1 backend consumes.
- Simple named presets on top of the general transform — `fit`, `cover`, `fill`,
  `1:1`, "center on point" — so the common cases stay one-liners.
- Gestures (wheel-zoom, drag-pan, pinch) that only mutate viewport state and let the
  backend's present loop redraw — no new draw code, no wire change.

This lands after item 1 gives it the `{ src, dst }` primitive and the present loop; see
the same **[display backend proposal](proposals/active/client_display_backend.md)** (§9)
for how the two layers meet.

## 3. Resolution as an adaptive lever

_benefit: medium · difficulty: moderate_

`AdaptiveQualityController` (`adaptive.py`) has three levers — bitrate, fps, then
in-flight — but **not resolution**. In the push model the publisher owns the
framebuffer size, so resolution-scale adaptation was deliberately left to the render
loop. That's a real gap: on a congested link, dropping to a smaller encode is often
the best quality-per-bit move, and every client re-`configure()`s cleanly on a resize
already (the encoder rebuild + keyframe path is well-trodden).

Add a server-driven **downscale hint** (a fourth lever, or a `set_quality` field the
publisher can honor) so the loop can shrink the encoded frame under pressure and
recover when healthy — without hand-rolling it in every app.

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

## 4. AV1 / HEVC codecs

_benefit: medium · difficulty: high_

Better compression at the same bitrate. The encoder registry + capability negotiation
already model this cleanly (`register_video_encoder`, `select_transport`), and the
browser decodes via WebCodecs. Two fronts: `av1_nvenc`/HEVC on the GPU paths, and a
CPU AV1 encoder (libaom / SVT-AV1) mirroring the libx264 backend. Gate the client on
`VideoDecoder.isConfigSupported` exactly like the H.264 path. Also unlocks the 10-bit /
HDR pipeline `types.ColorSpace` already models (`bit_depth`, `bt2020`/`pq`/`hlg` are
expressible but not yet wired through a 10-bit encode/decode chain).

## 5. Record to MP4 (server-side tap + client-side batteries)

_benefit: high · difficulty: moderate_

A first-class "record what I'm publishing / viewing to an MP4" convenience. Today
producing a demo clip means hand-rolling a muxer around the publish loop; this should be
a one-liner. Two variants, deliberately symmetric:

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
  the `<RemoteFramebuffer>` batteries chrome (a sibling to the existing `capture PNG`
  button). Lives in the batteries tier, not the headless primitive. A later refinement
  could mux the already-decoded `EncodedVideoChunk`s directly (no re-encode) when the
  container/codec line up.

The two share nothing but the intent; ship whichever is more useful first (the server tap
is the more broadly useful one for demos and headless capture).

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
