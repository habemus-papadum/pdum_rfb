# Roadmap / What's Next

The image and CPU-H.264 paths work end-to-end and are verified headlessly
(pytest + Vitest + Playwright). This page proposes where to go next, roughly in
priority order. Items marked _(addendum)_ come from the
[design addendum](remote_framebuffer_addendum.md).

## 1. Measure & adapt the software encoder ✅ _(done)_

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

## 2. "Still after interaction settles" _(addendum §1)_

For sparse/interactive viz: stream lossy JPEG/H.264 while the user interacts, then
~100–250 ms after input stops, send one **lossless PNG** (or a high-quality IDR).
Pairs with the new `OnDemandFrameSource`. Small, high-impact polish.

## 3. Logical-channel transport abstraction _(addendum §2)_

The **seam exists**: `transport.py` defines a `Channel` protocol and a
`WebSocketTransport`, and `RfbSession` is constructed with it (it only needs `send`
+ async iteration). A pluggable `authenticate` hook (`auth.py`) is already fed a
transport-neutral `AuthContext`. Remaining: a Starlette/ASGI `WebSocket` adapter
(so the stream can be mounted same-origin and reuse an OAuth cookie) and the
multi-lane split below.

Introduce a `Transport` / `Channel` interface (one socket today, WebTransport
later) so video, control, events, and telemetry are separate logical lanes. The
session already only needs `send` + async iteration, so this is mostly additive:

```text
WebSocketTransport:   app-level channel IDs + priority queue over one socket
WebTransportTransport: real QUIC streams for channels, datagrams for latest-wins
                       events/acks (reduces head-of-line blocking)
```

Architecturally important; unblocks WebTransport without touching encoders/sources.

## 4. Framework & notebook adapters

The core is framework-agnostic by design; add thin, optional wrappers:

- a `useRemoteFramebuffer` React hook (`@habemus-papadum/rfb-widgets/react`);
- a Jupyter/marimo widget (anywidget) — the repo already reserves `widgets/` and
  has notebook conventions. Makes the library usable from a notebook in one line.

## 5. NVIDIA NVENC backend ✅ _(host-memory + zero-copy CUDA paths done)_

- **Encoder** — `encoders/nvenc.py` (`NvencH264Encoder`): hardware H.264 via
  **PyAV's `h264_nvenc`** (its bundled ffmpeg is built with NVENC), emitting the
  same low-latency Annex B as the libx264 path. Registered as `"nvenc"`; `serve()`
  auto-detects via `nvenc_available()` (OS + `h264_nvenc` + a real GPU open, cached
  with retry) and prefers it, with `--no-nvenc` / `has_nvenc=False` to opt out.
- **Why PyAV, not PyNvVideoCodec** — NVIDIA's `PyNvVideoCodec` publishes no
  `cp314` wheel and no sdist, so it cannot install on Python 3.14+. PyAV's NVENC
  needs no extra Python package (only the host NVIDIA driver), so it is the
  pragmatic host-memory backend.

- **Zero-copy CUDA path** ✅ — `encoders/nvenc_cuda.py` (`CudaNvencEncoder`,
  registered `"nvenc_cuda"`) + `gpu.py`: a CuPy/DLPack NV12 (or RGB) device buffer
  is fed straight to `h264_nvenc` via `from_dlpack` with **no host copy**. Opt in
  with `serve(gpu=True)` and `publish()` a CuPy tensor; ~2.4–4.3× lower per-frame
  latency than the host path (1080p 2.5 ms vs 7.3 ms). **Needs PyAV ≥ 18** (the
  encode-side `hw_frames_ctx` wiring lands in 18.0 — gated by
  `gpu.cuda_zerocopy_available()`); a pure-Python monkey-patch is impossible on
  17.x, so `< 18` builds PyAV from source. See `docs/gpu_zerocopy.md` and
  `python -m pdum.rfb.benchmark --gpu`.

Remaining: NVENC AV1 (`av1_nvenc`) and HEVC; a zero-copy OpenGL/CUDA-interop source;
and CI on a Linux/NVIDIA runner (the encoders are GPU-gated, so their tests skip
without a device).

## 6. Rendering & codec upgrades

- `VideoFrame → WebGL/WebGPU` texture instead of `drawImage` for cheaper
  composition (measure first).
- **AV1** (`av01...`) via libaom/SVT-AV1 + WebCodecs for better compression at the
  same bitrate.
- Reconnection/backoff hardening and a proper keyframe-after-idle policy.

## 7. Packaging & release

Publish `@habemus-papadum/rfb-widgets` to npm and ship a versioned `dist/`; confirm the
`habemus-papadum-rfb[h264]` extra resolves on Linux CI (it already does on
macOS-arm64 with a `cp314` wheel). Add the widget e2e to the release gate.
