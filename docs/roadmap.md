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

## 1. Client-side viewport: crop, zoom, and pan

_benefit: high · difficulty: moderate_

This is **entirely a client concern** — the server does not zoom and never needs to
know the client's zoom/pan. The publisher owns the framebuffer; the client decides how
to fit that frame into its canvas and where the viewer is looking, and does its own
coordinate transforms so input events map back to frame space. Keeping the transform
on the client is the whole point: one shared encoded stream, N viewers each framing it
however they like, no per-client server render.

Today the client's sizing is rigid — a small fixed set of fit modes. The work is to
make it **arbitrary**:

- A general viewport transform (crop rect + zoom + pan) rather than fixed fit. The
  geometry seam already exists: `viewport.ts` reserves `zoom`/`panX`/`panY` (identity
  today) and `backingToFrame`/`frameDestRect` already round-trip event coordinates, so
  gestures can drive zoom/pan without any wire change.
- Simple named presets on top of the general transform — `fit`, `cover`, `fill`,
  `1:1`, "center on point" — so the common cases stay one-liners.

The scaling/compositing method should be **pluggable**, not baked in. The worker
composites decoded `VideoFrame`s with `drawImage` onto the transferred
`OffscreenCanvas` today; a zoomed/cropped viewport is a natural place to add a
WebGL (and later WebGPU) compositor that uploads the frame to a texture and samples the
ROI on the GPU. Pick the renderer by capability; `drawImage` stays the floor. **Measure
first** — `drawImage` of a hardware `VideoFrame` is already fast, so the GPU path only
pays off once zoom/pan or profiling shows compositing is a real cost.

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
recover when healthy — without hand-rolling it in every app.

## 3. AV1 / HEVC codecs

_benefit: medium · difficulty: high_

Better compression at the same bitrate. The encoder registry + capability negotiation
already model this cleanly (`register_video_encoder`, `select_transport`), and the
browser decodes via WebCodecs. Two fronts: `av1_nvenc`/HEVC on the GPU paths, and a
CPU AV1 encoder (libaom / SVT-AV1) mirroring the libx264 backend. Gate the client on
`VideoDecoder.isConfigSupported` exactly like the H.264 path. Also unlocks the 10-bit /
HDR pipeline `types.ColorSpace` already models (`bit_depth`, `bt2020`/`pq`/`hlg` are
expressible but not yet wired through a 10-bit encode/decode chain).

## 4. Record to MP4 (server-side tap + client-side batteries)

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
