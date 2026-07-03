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

---

What follows is the short list of what's actually left. It is deliberately not
exhaustive. Each item carries a rough **benefit · difficulty** read to help triage.

## 1. Record to MP4 — the client-side (browser) half

_benefit: high · difficulty: moderate_

The server-side tap shipped; this is its symmetric counterpart: record exactly what the
**viewer** sees — fit/zoom/pan and all — in the browser. `captureStream()` the display
canvas into a `MediaRecorder` (webm/mp4 per browser support), exposed as
`startRecording()` / `stopRecording(): Promise<Blob>` on `RemoteFramebufferView` and
surfaced as a control in the `<RemoteFramebuffer>` batteries chrome (a sibling to the
existing `capture PNG` button). Lives in the **batteries tier**, not the headless
primitive. A later refinement could mux the already-decoded `EncodedVideoChunk`s directly
(no re-encode) when the container/codec line up. Note: the zoom/pan viewport now shipped,
so "what the viewer sees" is a genuinely richer target than a plain fit.

## 2. Agent-friendly frontend observability

_benefit: high · difficulty: moderate_

The marimo bug was only findable via ad-hoc `window.__rfb*` hooks that were then removed;
productize them as first-class, **runtime-toggleable, off-by-default** features (zero
console spam in normal use, flippable from the console without a rebuild). Full write-up:
[marimo proposal §7](proposals/active/marimo_rendering_fix.md) + the existing
[agentic frontend debugging guide](agentic_frontend_debugging.md). The pieces:

- **Forward worker logs to the main thread.** Worker `console.*` is invisible to the
  browser MCP tools (they only see main-thread/page logs). Add a log sink that
  `postMessage`s each line to main, where it's re-logged (now readable) **and** pushed into
  a bounded ring buffer on `window.__rfb.logs`. Gated by the debug flag → free when off.
- **A `window.__rfb` registry + state snapshot.** Each view registers itself; expose
  `window.__rfb.stats()` / `.state()` / `.surface()` / `.capture()` so an agent or human can
  interrogate a live view from the console (the productized form of the temp hooks).
- **Runtime debug toggle.** `window.__rfb.setDebug(true)` posts `{type:"set_debug"}` to the
  worker (rebuilds its logger) — no rebuild, no kernel restart. One discoverability `notice`
  line on first construct names the handle. Optional `?debug=1` / `localStorage.rfbDebug`.
- **A cadence heartbeat** — one periodic summary line (fps/dropped/queue/RTT) instead of
  per-frame spam, forwarded from the worker to main.

This is the natural home for the stall-watchdog / detach-reattach lessons the debugging
guide already documents, and it directly serves the agent+human pairing loop
(`pdum-rfb demo --dev`).

## 3. Finish the draw-path measurement: the worker→main transfer cost

_benefit: low · difficulty: moderate_

The draw-path benchmark answered the *present* side (negligible on every backend) but not
the other half of "is Mode B worth it?": the cross-thread `VideoFrame` **transfer + upload**
cost (worker decode → transfer to main → texture upload), which needs a real
decode-under-load harness rather than a synthetic frame loop. Measuring it closes the
`surface: "auto"` story and the proposal's last open §15 follow-up.

## 4. marimo auto-start UX (small)

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
