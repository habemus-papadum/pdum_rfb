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

- a `useRemoteFramebuffer` React hook (`pdum-rfb-widgets/react`);
- a Jupyter/marimo widget (anywidget) — the repo already reserves `widgets/` and
  has notebook conventions. Makes the library usable from a notebook in one line.

## 5. NVIDIA NVENC backend

Implement `encoders/nvenc_pynv.py` (PyNvVideoCodec) for the host-memory path, then
the CUDA-buffer path, registering via `register_video_encoder("nvenc", ...)`. The
registry + `has_nvenc` negotiation flag already leave the seam. Requires a
Linux/NVIDIA box (out of scope on this Mac), so develop/CI it separately.

## 6. Rendering & codec upgrades

- `VideoFrame → WebGL/WebGPU` texture instead of `drawImage` for cheaper
  composition (measure first).
- **AV1** (`av01...`) via libaom/SVT-AV1 + WebCodecs for better compression at the
  same bitrate.
- Reconnection/backoff hardening and a proper keyframe-after-idle policy.

## 7. Packaging & release

Publish `pdum-rfb-widgets` to npm and ship a versioned `dist/`; confirm the
`habemus-papadum-rfb[h264]` extra resolves on Linux CI (it already does on
macOS-arm64 with a `cp314` wheel). Add the widget e2e to the release gate.
