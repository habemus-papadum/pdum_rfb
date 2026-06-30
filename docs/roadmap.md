# Roadmap / What's Next

The image, CPU-H.264, and GPU NVENC paths all work end-to-end and are verified
headlessly (pytest + Vitest + Playwright; the GPU tier runs weekly on real
hardware). **Multiple browser clients also already work** — the push `Display` fans
every frame out to N viewers, each with its own `RfbSession`/encoder/backpressure.

This page proposes where to go next; items carry a rough **benefit · difficulty**
read to help triage. Items marked _(addendum)_ come from the
[design addendum](remote_framebuffer_addendum.md).

## Current plan

Agreed execution order — the section numbers below are **stable identifiers, not the
work order**. We proceed one item at a time, committing at each milestone:

1. ~~**§2** — "still after interaction settles"~~ ✅ **done** (`serve(still_after=)`;
   see [Still after settle](still_after_settle.md))
2. ~~**§8** — multiple streams per server (named displays)~~ ✅ **done**
   (`serve_server()` / `display.server.add_stream(...)`; see
   [Multiple streams](multiple_streams.md))
3. **§3** — ASGI / Starlette adapter (WebTransport stays deferred) — **▶ next**
4. **§1** — adaptive / metrics remaining polish

**Skipped** (by request): **§4** framework & notebook adapters. **Tabled** (revisit
later): **§5** remaining (AV1 / HEVC / zero-copy interop) and **§6** (rendering &
codec upgrades). **Done:** §2, §7, §8.

## 1. Measure & adapt the software encoder ✅ _(core done)_ · **▶ step 4 — remaining polish**

- **Per-session metrics** — `metrics.py` (`SessionMetrics`): encode_ms, payload
  bytes, in-flight, ACK RTT, decode-queue depth, fps, bitrate; exposed via
  `session.metrics_snapshot()` and `GET /metrics`.
- **Offline benchmark** — `python -m pdum.rfb.benchmark`: image vs H.264 across
  patterns/resolutions with **real PSNR** (decodes the output back).
- **Adaptive quality** — `adaptive.py` (`AdaptiveQualityController`), opt-in via
  `serve(adaptive=True)` / `--adaptive`: lowers bitrate (then tightens in-flight at
  the floor) on congestion, recovers when healthy, with a cooldown; rebuilds the
  encoder and emits `set_quality`.

Remaining polish: surface RTT/quality in the client `Stats` and have the worker act
on `set_quality`; add a `fps` knob; resolution-scale adaptation.

## 2. "Still after interaction settles" ✅ _(done)_ _(addendum §1)_

Stream lossy JPEG/H.264 while the user interacts, then — once no new frame has been
published for `still_after` seconds — re-send each viewer a high-quality still of the
resting frame: a **lossless PNG** on the image path, a clean **IDR** on the video
path. Opt in with `serve(still_after=0.15)`; zero cost while interacting, no
client-side changes. Implemented as an optional `encode_still()` encoder capability
fed by `Display`'s `still_frame()`. See [Still after settle](still_after_settle.md).

## 3. Logical-channel transport: ASGI now, WebTransport later — **▶ step 3 (ASGI only)** _(addendum §2)_

This is about the *transport*, **not** multi-client (which already works over plain
WebSocket — see the intro). The **seam exists**: `transport.py` defines a `Channel`
protocol and a `WebSocketTransport`, `RfbSession` only needs `send` + async
iteration, and `authenticate` is fed a transport-neutral `AuthContext`.

- **ASGI / Starlette WebSocket adapter** — _benefit: high · difficulty: moderate._
  Mount the stream same-origin inside an existing app and reuse its session/OAuth
  cookie. Highest-leverage transport work; drops into the `Channel` seam (translate
  `WebSocketDisconnect` onto the `ConnectionClosed` the session already catches).
  Purely **opt-in**: an optional `[asgi]` extra and a second front-end over the same
  `Display`/`RfbSession` core — the standalone `serve()` path (and its
  zero-extra-deps `websockets` listener) is unchanged. The only difference for the
  app is that the ASGI server owns the event loop, so the `Display` is created at
  app startup and the publish loop runs as a background task.
- **WebTransport (HTTP/3)** — _benefit: modest for sparse viz · difficulty: high._
  Real QUIC streams per logical lane (video / control / events / telemetry) plus
  unreliable **datagrams** for latest-wins events/acks, removing head-of-line
  blocking. Needs an HTTP/3 server stack (e.g. `aioquic`), TLS certs, and is
  Chromium-only on the client. Worth it only if HOL blocking actually bites (high
  frame rates, many lanes) — it is **not** a prerequisite for multi-client (done) or
  multiple streams (§8, which works fine over WebSocket).

```text
WebSocketTransport:   app-level channel IDs + priority queue over one socket (today)
WebTransportTransport: real QUIC streams for channels, datagrams for latest-wins
                       events/acks (reduces head-of-line blocking)
```

## 4. Framework & notebook adapters — **⏸ skipped (by request)**

The core is framework-agnostic by design; add thin, optional wrappers:

- a `useRemoteFramebuffer` React hook (`@habemus-papadum/rfb-widgets/react`);
- a Jupyter/marimo widget (anywidget) — the repo already reserves `widgets/` and
  has notebook conventions. Makes the library usable from a notebook in one line.

## 5. NVIDIA NVENC backend ✅ _(host-memory, zero-copy CUDA, and PyAV-free SDK paths done)_ · **⏸ remaining tabled**

- **Encoder** — `encoders/nvenc_cpu.py` (`NvencCpuEncoder`): hardware H.264 via
  **PyAV's `h264_nvenc`** (its bundled ffmpeg is built with NVENC), emitting the
  same low-latency Annex B as the libx264 path. Registered as `"nvenc_cpu"`; `serve()`
  auto-detects via `nvenc_cpu_available()` (OS + `h264_nvenc` + a real GPU open, cached
  with retry) and prefers it, with `--no-nvenc` / `has_nvenc=False` to opt out.
- **Why PyAV, not PyNvVideoCodec** — NVIDIA's `PyNvVideoCodec` publishes no
  `cp314` wheel and no sdist, so it cannot install on Python 3.14+. PyAV's NVENC
  needs no extra Python package (only the host NVIDIA driver), so it is the
  pragmatic host-memory backend.

- **Zero-copy CUDA path** ✅ — `encoders/nvenc_gpu_pyav.py` (`NvencGpuPyavEncoder`,
  registered `"nvenc_gpu_pyav"`) + `gpu.py`: a CuPy/DLPack NV12 (or RGB) device buffer
  is fed straight to `h264_nvenc` via `from_dlpack` with **no host copy**. Opt in
  with `serve(gpu=True)` and `publish()` a CuPy tensor; ~2.4–4.3× lower per-frame
  latency than the host path (1080p 2.5 ms vs 7.3 ms). **Needs PyAV ≥ 18** (the
  encode-side `hw_frames_ctx` wiring lands in 18.0 — gated by
  `gpu.cuda_zerocopy_available()`); a pure-Python monkey-patch is impossible on
  17.x, so `< 18` builds PyAV from source. See `docs/gpu_zerocopy.md` and
  `python -m pdum.rfb.benchmark --gpu`.
- **PyAV-free NVENC SDK path** ✅ — `encoders/nvenc_gpu_pdum.py` (`NvencGpuPdumEncoder`,
  registered `"nvenc_gpu_pdum"`) rides the sibling package `habemus-papadum-nvenc`
  (`pdum.nvenc`, built from `packages/nvenc/`): a thin pybind11 binding over
  NVIDIA's Video Codec SDK encoder, **no PyAV at all** — so it sidesteps the
  unreleased-PyAV-18 problem entirely. `serve(gpu=True)` **prefers** it (gated by
  `nvenc_gpu_pdum_available()`), falling back to `nvenc_gpu_pyav`. It's the fastest path
  measured (1080p ~2.3 ms). See `docs/nvenc_sdk_evaluation.md`.

Remaining: NVENC AV1 (`av1_nvenc`) and HEVC; a zero-copy OpenGL/CUDA-interop source;
true zero-copy device input via `RegisterResource` (the SDK path does one intra-GPU
copy today). GPU CI now exists as the weekly self-hosted `gpu-tests` workflow.

## 6. Rendering & codec upgrades — **⏸ tabled**

- `VideoFrame → WebGL/WebGPU` texture instead of `drawImage` for cheaper
  composition (measure first).
- **AV1** (`av01...`) via libaom/SVT-AV1 + WebCodecs for better compression at the
  same bitrate.
- Reconnection/backoff hardening and a proper keyframe-after-idle policy.

## 7. Packaging & release ✅ _(pipeline in place)_

`scripts/release.sh` bumps all four version files in lockstep and publishes all
three packages — `habemus-papadum-rfb` + `habemus-papadum-nvenc` to PyPI (via
`scripts/publish.sh`) and `@habemus-papadum/rfb-widgets` to npm — then cuts a GitHub
release that redeploys the docs. The widget Vitest + Playwright e2e already run in
CI (`ci.yml`). See [Repository & Development](development.md#releasing-the-pipeline).

Remaining polish: a packaged non-`blob:` worker subpath export for the widgets (for
strict-CSP sites), and broader GPU-wheel coverage (aarch64, more manylinux tags).

## 8. Multiple streams per server (named displays) ✅ _(done)_ _(benefit: high · difficulty: moderate)_

Host several framebuffers from one port — different cameras/viewports of a
simulation, a dashboard of independent plots, or a per-user view — each an
independent `Display` clients attach to by URL path, discoverable via a REST
listing. Distinct from multi-client (many viewers of *one* stream) and from
WebTransport (§3): this works over plain WebSocket. As shipped:

- a **`Server`/hub** (`serve_server()`) owns the websockets listener + a
  `{name: _StreamHost}` registry, each `_StreamHost` being a `Display` plus its
  encoder config;
- **path routing**: `ws://host/<name>` selects the stream; no path → the `"default"`
  stream, so `serve(w, h)` and `RemoteFramebufferView({url})` are unchanged; an
  unknown stream closes with application code `4404`;
- the per-connection encoder config (`has_h264`/`has_nvenc`/`gpu`/`bitrate`/
  `adaptive`/`still_after`/`authenticate`) lives **on each stream**, so streams can
  differ (one GPU, one image; per-stream auth);
- **REST**: `GET /streams` → `[{name, width, height, fps, clients}]`,
  `GET /streams/<name>/metrics`; `AuthContext.stream` carries the stream name for
  per-stream authz;
- the one-liner holds: `serve(w, h)` returns the default stream with
  `display.server` reachable to `add_stream(...)`; `serve_server()` builds a hub with
  no default.

See [Multiple streams](multiple_streams.md). (Per-*client* viewport rendering from a
single shared scene is a harder, app-coupled variant — `_ClientFeed.viewport` is
already recorded toward it.)
