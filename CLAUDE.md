# CLAUDE.md

Guidance for Claude Code when working in this repository. See `AGENTS.md` for the
full agent rules (this file complements it with an architecture-oriented summary
distilled from `docs/`).

## What this project is

`pdum.rfb` (PyPI: `habemus-papadum-rfb`) is a **Remote Frame Buffer** library: it
streams a server-rendered framebuffer to a browser over a WebSocket, with input
events flowing back. The target use case is scientific/interactive visualization —
render in Python, view and interact in the browser. It is **not** a generic VNC
clone, but it spans the whole cadence range: from **sparse, on-demand scenes**
(jupyter_rfb-style, render only when state changes) to **high-frame-rate interactive
streaming** (low-latency H.264/WebCodecs, zero-copy CUDA→NVENC when rendering on GPU).
The publisher owns the loop and the cadence; the library never imposes a fixed tick.
Unlike jupyter_rfb it is **not tied to Jupyter/ipywidgets comms** — a plain WebSocket,
so it runs in any page, app, or headless box.

Two halves:

- **Python server** — `src/pdum/rfb/` (the published package). Python **3.14+**,
  UV-managed.
- **Browser client** — `widgets/`, a TypeScript package published as
  `@habemus-papadum/rfb-widgets`. All decoding runs in a **Web Worker** that owns the
  WebSocket, the decoder, and a transferred `OffscreenCanvas`.

## Core mental model

The public API is **push**: you own your loop and publish frames into a shared
`Display`; the library fans them out to every connected viewer.

```
your loop ── display.publish(ndarray) ──►  Display (latest frame, +version)
   ▲                                          │  one per connected browser:
   └── for ev in display.poll_events()        ├─► _ClientFeed → RfbSession → EncoderBackend → WebSocket
       (input from all viewers, tagged        └─► _ClientFeed → RfbSession → EncoderBackend → WebSocket
        with client_id + principal)
```

```python
display = await rfb.serve(1280, 720, port=8765)   # starts WS server in background, returns handle
while running:
    for ev in display.poll_events():     # ev.client_id, ev.principal, ev.event
        state = update(state, ev)
    display.publish(render(state))        # sync, non-blocking, latest-wins, fans out to all viewers
    await asyncio.sleep(1/30)             # or ad-hoc / every 60s — you own the cadence
await display.aclose()
```

`publish()` is synchronous (stores latest frame, bumps a version, wakes feeds) and
must run on the event-loop thread. Each browser connection gets its **own**
`RfbSession`+encoder (per-client backpressure/keyframes), fed from the display's
latest frame via an internal `_ClientFeed`. The encoder/transport are still chosen
by capability negotiation. The **pull** `FrameSource` model is internal-only now
(the session still pulls from `_ClientFeed`); `sources.py`/`SyntheticFrameSource`
are not part of the public API.

### Two transports

- **Image path** — one independent image per frame (JPEG/PNG/WebP via Pillow);
  every frame is a keyframe. Good for stills/snapshots and the lossless-final
  still. Dependency-light (numpy, pillow, websockets).
- **H.264 path** — CPU H.264 via PyAV/libx264 (`[h264]` extra), emitting **Annex B**
  access units for the browser's WebCodecs `VideoDecoder`. Low-latency config
  (`ultrafast`/`zerolatency`, no B-frames, ~1s IDR cadence, in-band SPS/PPS).
  `import pdum.rfb` works without the extra — PyAV symbols load lazily.

### Key invariants (don't break these)

- **Latest-frame-wins backpressure.** At most `max_inflight` payloads unacked;
  when the client is behind, frames are dropped **before** encoding and the next
  sent frame is forced to a keyframe (dropping already-encoded *delta* frames would
  strand the browser on references it never received). First frame to any client is
  a keyframe; `request_keyframe` forces one too.
- **Real, monotonic timestamps** propagate source → encoder → `EncodedVideoChunk`,
  so replay/recording/sync stay correct even with sparse frames.
- **Fixed-resolution encoders.** A resize rebuilds the encoder and forces a
  keyframe; the browser re-`configure()`s its decoder.
- **No B-frames** ⇒ decoder output order == input order ⇒ a FIFO of `seq`s
  attributes displayed frames for `displayed:true` ACKs. Enabling B-frames breaks
  this.
- Annex B only (never route H.264 through an mp4 muxer — that yields AVCC).

## Where things live

```
src/pdum/rfb/
  types.py        RawFrame, EncodedPayload, InputEvent, FrameSource/EncoderBackend protocols (dep-free)
  protocol.py     binary envelope, header builders, control parsing, select_transport
  session.py      RfbSession: recv_loop/encode_loop, backpressure, keyframe policy (UNCHANGED by push)
  display.py      Display (publish/poll_events/events/aclose) + internal _ClientFeed (per connection)
  auth.py         AuthContext, Authenticator, Principal — pluggable auth hook (no JWT dep)
  transport.py    Channel protocol + WebSocketTransport (the transport seam; ASGI rides it via asgi.py)
  sources.py      BaseFrameSource, RenderCallbackSource, OnDemandFrameSource (INTERNAL now, not exported)
  asgi.py         opt-in [asgi] Starlette front-end: rfb_endpoint / rfb_hub_endpoint + _AsgiConn
  server.py       serve()->Display, serve_server()->Server hub (named streams, URL-path routing,
                  /streams REST), _StreamHost (transport-neutral _serve_connection), _WsConn, CLI
  gpu.py          zero-copy GPU helpers: rgb_to_nv12 kernel, cuda_frame, enable_cuda_context_sharing,
                  cuda_zerocopy_available, HostFrameAdapter (lazy-imports CuPy; see docs/gpu_zerocopy.md)
  encoders/
    base.py       registry + build_encoder  (registers h264_cpu + nvenc_cpu + nvenc_gpu_pyav + nvenc_gpu_pdum factories)
    image.py      ImageEncoder (Pillow)
    h264_cpu.py  H264CpuEncoder + h264_cpu_available / self_test
    nvenc_cpu.py      NvencCpuEncoder (GPU H.264 via PyAV h264_nvenc, host input) + nvenc_cpu_available
    nvenc_gpu_pyav.py NvencGpuPyavEncoder (zero-copy CUDA NV12 -> h264_nvenc via from_dlpack) + nvenc_gpu_pyav_available
  metrics.py      SessionMetrics (encode_ms, bytes, RTT, fps, bitrate, ...)
  adaptive.py     AdaptiveQualityController (opt-in via serve(adaptive=True))
  benchmark.py    `python -m pdum.rfb.benchmark` — offline image vs H.264 w/ real PSNR
  notebook.py     opt-in [anywidget] Jupyter/marimo widgets: RfbCanvas (bare) / RfbViewer (batteries)
                  + publish_loop(); Display.widget() lazy-imports it (see docs/notebook.md)
  static/         COMMITTED widget.{js,css} — prebuilt inlined-worker anywidget bundle (package data;
                  built from widgets/anywidget/ via `pnpm -C widgets build:anywidget`; .map gitignored)
  testing.py      SyntheticFrameSource, FakeWebSocket/FakeEncoder, NAL/decode helpers,
                  fixture gen (excluded from coverage on purpose)
  cli.py          `pdum-rfb` console script (Typer): doctor, benchmark, demo
  demos.py        Demo registry: CPU pattern scenes + paint (interactive) + mlx_shader (Metal)
  demo_tui.py     `pdum-rfb demo` orchestration: serve + render loop + Vite launch + smoke() self-test
  demo_app.py     the Textual TUI (lazy `[demo]` import): live scene/backend switch, quality, stats

widgets/                    pnpm workspace root = core pkg @habemus-papadum/rfb-widgets (importer ".")
  src/
    index.ts                  public exports
    RemoteFramebufferView.ts  main-thread controller (canvas, events, resize, capture)
    protocol.ts events.ts eventTypes.ts capabilities.ts backpressure.ts types.ts
    workerFactory.ts          inline worker (?worker&inline)
    worker/{entry,renderer,imageDecode,videoDecode}.ts
  anywidget/{entry,chrome}.ts vanilla-DOM anywidget front-end (2nd Vite build via
                              vite.anywidget.config.ts -> src/pdum/rfb/static/widget.js, NOT an npm pkg)
  packages/                   framework wrappers (separate npm packages, workspace members)
    rfb-ui/                   PRIVATE: shared rfb.css + pure helpers (bundled into wrappers, never published)
    react/                    @habemus-papadum/rfb-react  (useRemoteFramebuffer hook + <RemoteFramebuffer>)
    svelte/                   @habemus-papadum/rfb-svelte  (createRemoteFramebuffer action/stores + component; Svelte 5)
    solid/                    @habemus-papadum/rfb-solid   (createRemoteFramebuffer ref/signals + component)
  # Two tiers per wrapper: headless primitive (no CSS) + batteries <RemoteFramebuffer>
  # (opt-in styles.css, themeable via CSS vars + slots/render-props). Each peer-deps the
  # core; build externalizes framework+core; release.sh version-syncs all 4 npm packages.

packages/nvenc/             habemus-papadum-nvenc (import pdum.nvenc) — uv workspace member
  src/cpp/nvenc_ext.cpp     OURS: thin pybind11 binding over NVIDIA NvEncoderCuda (+ NVTX)
  src/pdum/nvenc/__init__.py  OURS: ABI loader (picks 12.1/13.0 by driver) -> NvencEncoder
  CMakeLists.txt build-wheel.sh  scikit-build-core; builds BOTH NVENC ABIs (_nvenc_121/_130)
  third_party/              VERBATIM NVIDIA SDK (MIT, unmodified — PROVENANCE.md)
```

This repo is a **uv workspace**: root = `habemus-papadum-rfb` (the published rfb
package), members = `packages/*`. `pdum` is a **PEP 420 namespace** (no
`src/pdum/__init__.py` in either package), so `habemus-papadum-rfb` contributes
`pdum.rfb` and `habemus-papadum-nvenc` contributes `pdum.nvenc` without conflict. The
nvenc package is **native** (scikit-build-core + auditwheel, needs a CUDA toolkit to
build) and is only built when its `gpu-nvenc-sdk` extra is requested — default
`uv sync` (incl. CI) never builds it. Both packages are published by
`scripts/publish.sh` (rfb via hatch; nvenc via auditwheel'd wheels through the same
`hatch publish`); **publishing is never done from CI**.

### Wire protocol

One WebSocket carries two message kinds:
- **Control (JSON text):** client→server `hello` (may carry an auth `token`), `ack`,
  `request_keyframe`, `set_viewport`, `event`; server→client `config`, plus optional
  `set_quality` (adaptive targets: bitrate/fps) and `stats` (server-truth metrics,
  opt-in via `serve(stats_interval=)`; the client folds both into its `Stats`). Auth:
  `serve(authenticate=...)` is called after `hello`, before `config`; rejected
  connections close with code `4401`. With a stream hub, a connection to an unknown
  URL-path stream closes with `4404`. In a shared display, `set_viewport`/`resize` is
  **informational** — the publisher owns resolution.
- **Payloads (binary):** one self-describing envelope per image/AU —
  `uint32le header_len | utf8 JSON header | raw bytes`. Atomic by design (no
  header/payload pairing race). The Python packer (`pack_binary_message`) and the
  TS unpacker (`unpackBinaryMessage`) are kept byte-compatible by **committed
  fixtures** in `widgets/tests/fixtures/protocol/`, regenerated via
  `python -m pdum.rfb.testing <dir>` and asserted in Vitest. If you change the
  envelope or headers, regenerate fixtures.

## Common commands

Python (from repo root):
```bash
./scripts/setup.sh                 # idempotent bootstrap: uv sync (GPU auto-detect via RFB_GPU),
                                   #   pnpm install + Playwright Chromium, pre-commit hooks
                                   #   RFB_GPU=auto|force|0 controls the gpu-nvenc-sdk build (Linux+GPU)
uv run pytest                      # all Python tests (runs with -s)
uv run ruff check . && uv run ruff format .
uv run python -m pdum.rfb.server --pattern bouncing_box --port 8765   # demo server/CLI
uv run python -m pdum.rfb.benchmark --frames 120 --pattern gradient   # offline encoder bench
```

Widgets (from `widgets/`, uses **pnpm**):
```bash
pnpm install
pnpm dev          # demo at http://localhost:5173 (?ws=...&transport=image|video)
pnpm typecheck    # tsc for library + worker (separate DOM / WebWorker libs)
pnpm test         # Vitest unit tests
pnpm build        # dist/index.js (+ .d.ts), worker inlined
pnpm e2e          # Playwright headless e2e (boots the Python server + demo)
```

## Testing strategy (three layers, all headless)

1. **pytest** — protocol round-trips (+ golden fixtures for JS), image-encoder
   validity (re-decoded with Pillow), session invariants (max_inflight,
   keyframe-first, latest-frame-wins, forced-keyframe-on-drop, events), negotiation,
   and H.264 Annex B **decoded back with PyAV** to prove validity. One real
   loopback-socket integration test.
2. **Vitest** — unpacker asserted byte-for-byte vs Python fixtures; event-coordinate
   scaling and backpressure/keyframe-gate logic in isolation.
3. **Playwright** — boots the Python server (deterministic `test_card`) + a prod
   demo build, decodes real frames, reads back canvas pixels and compares to
   `expectedQuadrantColor` (TS mirror of Python's `render_test_pattern`); a second
   spec injects real input and checks `GET /recorded-events`. H.264 path is gated on
   `VideoDecoder.isConfigSupported`.

`SyntheticFrameSource` / `render_test_pattern` / `expected_quadrant_color` are the
cross-language contract — keep the Python and TS sides in sync.

## Extension seams

- **Encoders:** `register_video_encoder(name, factory)` + the `has_nvenc` flag in
  `select_transport`. The GPU **NVENC** backend (`encoders/nvenc_cpu.py`) already uses
  this seam: it rides on PyAV's bundled `h264_nvenc` (no extra Python dep beyond
  `av`), is gated by `nvenc_cpu_available()` (OS + GPU probe), and `serve()` auto-prefers
  it. The **zero-copy CUDA** backend (`encoders/nvenc_gpu_pyav.py`, registered
  `"nvenc_gpu_pyav"`) slots in the same way: opt in with `serve(gpu=True)` + `publish()` a
  CuPy/DLPack frame; gated by `gpu.cuda_zerocopy_available()` (needs **PyAV ≥ 18** —
  the encode-side `hw_frames_ctx` wiring; a pure-Python monkey-patch is impossible on
  17.x). See `docs/gpu_zerocopy.md`. The **PyAV-free** GPU backend
  (`encoders/nvenc_gpu_pdum.py`, registered `"nvenc_gpu_pdum"`) rides the sibling package
  `pdum.nvenc` (`packages/nvenc/`): `serve(gpu=True)` **prefers it** when
  `nvenc_gpu_pdum_available()`, else falls back to `nvenc_gpu_pyav` (PyAV≥18). It needs no
  PyAV at all and is the fastest path measured. The SDK encoder is configured
  `extra_output_delay=0` (zero-latency, synchronous 1-in-1-out) so each frame's access
  unit comes back from its own `encode()` call — required for correct seq attribution.
- **Frames:** push `ndarray`s, **CuPy/DLPack CUDA tensors**, or `RawFrame`s to
  `Display.publish()` (a CUDA tensor becomes a `memory="cuda"` frame; the type
  already modelled this). The internal `_ClientFeed` (in `display.py`) is the
  per-connection `FrameSource` the session pulls; `BaseFrameSource`/
  `SyntheticFrameSource` remain for internal/test use.
- **Auth:** `serve(authenticate=async fn)` — `fn(AuthContext) -> principal | None`.
  v1 reads the token from `hello`; `AuthContext` also carries headers/cookies/path so
  a future same-site-cookie/ASGI path feeds the same hook. No JWT dep in the library.
- **Transport:** `transport.py`'s `Channel` protocol + `WebSocketTransport` is the
  seam; the **ASGI** front-end (`asgi.py`, opt-in `[asgi]`) already rides it — the
  per-connection lifecycle is transport-neutral (`_StreamHost._serve_connection`), so
  both the `websockets` listener (`_WsConn`) and a Starlette WebSocket (`_AsgiConn`)
  share it. A WebTransport adapter would drop in the same way (still deferred).
- **Streams:** `serve_server()` → a `Server` hub fronts several named `Display`s on
  one port (URL-path routing, `GET /streams`); `serve()` is the single-`"default"`-
  stream case and exposes the hub via `display.server`. See `docs/multiple_streams.md`.

## Project status & roadmap

Image, CPU-H.264, and GPU NVENC paths work end-to-end and are verified headlessly.
The four planned roadmap items are **done** (see `docs/roadmap.md`): **§2** "still
after interaction settles" (`serve(still_after=)`, `docs/still_after_settle.md`),
**§8** multiple streams (`serve_server()`, `docs/multiple_streams.md`), **§3** the
opt-in **ASGI/Starlette** front-end (`docs/asgi.md`), and **§1** adaptive/metrics
polish (fps lever + opt-in server→client `stats` push surfaced in the client
`Stats`). Done earlier: per-session metrics + `GET /metrics`, offline PSNR benchmark,
adaptive quality, the NVENC backends. **§4 framework & notebook adapters — done:**
React/Svelte/Solid npm wrappers (`widgets/packages/*`) and the Jupyter/marimo
**anywidget** (`pdum.rfb.notebook`, `[anywidget]` extra, `docs/notebook.md`). Tabled:
AV1/HEVC (§5), codec/rendering upgrades (§6), WebTransport.

## Hard rules (from AGENTS.md — do not violate)

- **NEVER modify version numbers** — humans manage them (`pyproject.toml`,
  `__init__.py` `__version__`, docs). Flag if you think a bump is needed.
- **NEVER run `./scripts/release.sh`** (publishes to PyPI, creates public GitHub
  releases, pushes tags). Humans only.
- After changing any demo notebook (`docs/demos/*.ipynb`), run
  `./scripts/test_notebooks.sh`.
- Conventions: src-layout, UV exclusively (`uv.lock` committed; use
  `uv sync --frozen`), Hatchling build, ruff (target 3.14, line length 120,
  rules E/F/W/I), NumPy-style docstrings.

## Docs map

- `docs/guide_python.md` — Python user guide (sources, encoders, serve(), events,
  metrics, adaptive, testing helpers).
- `docs/guide_javascript.md` — browser client guide (`RemoteFramebufferView`,
  options, framework integration, CSP/worker packaging).
- `docs/demo.md` — the `pdum-rfb demo` harness (Textual TUI + Vite client): live scene /
  backend switching, quality retune, stats, the `--smoke` headless self-test.
- `docs/notebook.md` — Jupyter/marimo anywidget (`display.widget()`, `RfbCanvas`/
  `RfbViewer` tiers, `publish_loop`, local vs remote/HTTPS same-origin ASGI, multi-stream,
  theming, CSP/mixed-content).
- `docs/gpu_zerocopy.md` — zero-copy CUDA→NVENC (CuPy/DLPack NV12 → `h264_nvenc`):
  `serve(gpu=True)`, the helpers, NV12, the PyAV-18 requirement + why no pure-Python
  monkey-patch, the from-source recipe, the NVENC-SDK alternative, benchmarks.
- `docs/internals.md` — data flow, wire protocol, session loop, H.264 path, worker,
  module map, testing architecture, extension points.
- `docs/roadmap.md` — what's next.
- `docs/remote_framebuffer.md`, `docs/remote_framebuffer_addendum.md`,
  `docs/remote_framebuffer_implementation_guide.md` — original design notes.
- `docs/reference.md` — auto-generated API reference (mkdocstrings).
