# Roadmap / What's Next (v2)

The image, CPU-H.264, GPU-NVENC (host + zero-copy CUDA + SDK), and Apple
VideoToolbox paths all work end-to-end and are verified headlessly (pytest +
Vitest + Playwright; the GPU tier runs weekly on real hardware). Multiple browser
clients, multiple named streams, still-after-settle, the ASGI/Starlette front-end,
adaptive quality/metrics, auto-reconnect, and the framework + notebook adapters are
all shipped and no longer tracked here.

## Recently shipped (previous roadmap items — done)

The last roadmap cycle landed a batch of client + server work; the design notes live
in the linked docs, not here:

- **Client display backend** — a pluggable draw path (Canvas2D / WebGL2 / WebGPU) in
  both Mode A (managed present) and Mode B (frame-as-texture, `FrameTextureFeed`).
  → [proposal](proposals/completed/client_display_backend.md).
- **Core viewport UI** — general crop/zoom/pan transform, named presets (`fit`/`cover`/
  `fill`/`1:1`/center), gestures, event inverse-mapping — plus a **batteries backend-switch
  chrome** (live `2d`/`webgl`/`webgpu` selector + zoom controls in the anywidget and
  React/Svelte/Solid wrappers) and the `pdum-rfb demo` exposing both.
- **Resolution as an adaptive lever** — a fourth `AdaptiveQualityController` lever surfaced
  as a typed `DownscaleHint` through `Display.poll_events()` that the render loop honors.
  → [Python guide](guide_python.md).
- **Record to MP4 — server-side tap** — `Display.record("out.mp4")` muxes real AVCC-in-MP4
  off the published-frame stream, headless, honoring monotonic timestamps.
- **marimo blank-viewer fix** — a reparent-safe main-thread present path, defaulted
  host-aware (main-thread only under marimo; Jupyter keeps the lower-overhead Mode A path).
  → [notebook guide](notebook.md), [proposal](proposals/active/marimo_rendering_fix.md).
- **Draw-path benchmark ("measure first")** — a headless bench timing Canvas2D vs WebGL2 vs
  WebGPU present, with real WebGPU GPU-timing. Finding: per-frame *present* cost is
  negligible and ~equal across backends, so Canvas2D stays the default and GPU pays for
  compositing/zoom, not a faster present. → proposal §15.
- **Client-side browser recording** — `startRecording(options?)` / `stopRecording(): Promise<Blob>`
  via `canvas.captureStream()` → `MediaRecorder`, on the main-thread present path
  (`MainThreadPresentView`; `canRecord` reports where it's supported — Mode A's OffscreenCanvas
  can't `captureStream`), with a record toggle in the batteries chrome + demo.
  → [JS guide](guide_javascript.md#recording-what-the-viewer-sees).
- **Agent-friendly frontend observability** — a standalone, reusable **private** package
  `@habemus-papadum/worker-observability` (worker→main log bridge so worker logs reach the
  Chrome-MCP-readable main console, a `window.__rfb` registry + state snapshots, runtime
  `setDebug`, heartbeat), adopted by rfb. Principles for reuse in any Web-Worker project:
  [agent-observable web workers](agent_observable_web_workers.md).
- **Draw-path transfer measurement** — the worker→main transfer + upload half of the bench:
  the cross-thread hop is free over decode, so Mode B's frame-as-texture adds no measurable
  submit-side cost. → proposal §15.1.
- **Demo chrome + wheel-zoom** — the `pdum-rfb demo` now mounts the full batteries toolbar
  (capture/zoom/fit/backend icons, root-caused: it had mounted the bare core view with no
  chrome); wheel-zoom sensitivity halved.

---

What follows is the short list of what's actually left. It is deliberately not
exhaustive. Each item carries a rough **benefit · difficulty** read to help triage.

## 1. marimo auto-start UX (small)

_benefit: low · difficulty: low_

Loose end from the marimo work: the demo server is button-gated by design, but marimo cells
*do* auto-instantiate — document a safe auto-start recipe and marimo's
`runtime.auto_instantiate` config so the demo can come up without a manual click where that's
wanted. See the [marimo proposal](proposals/active/marimo_rendering_fix.md) (Problem 1).

---

## Parked (valuable, not scheduled)

### AV1 / HEVC codecs

_benefit: medium · difficulty: high_

Better compression at the same bitrate. The encoder registry + capability negotiation
already model this cleanly (`register_video_encoder`, `select_transport`), and the
browser decodes via WebCodecs. Two fronts: `av1_nvenc`/HEVC on the GPU paths, and a
CPU AV1 encoder (libaom / SVT-AV1) mirroring the libx264 backend. Gate the client on
`VideoDecoder.isConfigSupported` exactly like the H.264 path. Also unlocks the 10-bit /
HDR pipeline `types.ColorSpace` already models (`bit_depth`, `bt2020`/`pq`/`hlg` are
expressible but not yet wired through a 10-bit encode/decode chain). Parked until there's
a concrete need.
