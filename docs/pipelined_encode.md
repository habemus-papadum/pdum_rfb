# Pipelined encode (`serve(encode_pipeline_depth=…)`)

By default `pdum.rfb` runs the H.264 encoder **synchronous, 1-in-1-out**: each published
frame is encoded and its access unit (AU) shipped before the next frame is pulled. That is
optimal for the library's interactive, latest-frame-wins model — lowest glass-to-glass
latency, and frame↔`seq` attribution is trivially correct. This page documents the opt-in
**pipelined** path for the throughput-bound case, what it costs, and — importantly — **which
backends it actually helps** (measured).

> **TL;DR.** Leave it at the default (`0`) for interactive use. Set
> `serve(encode_pipeline_depth=k>0)` only when you are throughput-bound (very high fps, 4K,
> many concurrent streams) **and** running the **NVENC** backend. On **VideoToolbox** it is
> correct but **not faster** (measured below); on the libx264/PyAV backends it is currently a
> no-op.

## What "1-in-1-out" buys, and why pipelining needs care

The session never parses the bitstream to learn which AU belongs to which published frame.
It relies on **call ordering**: `encoder.encode(frame_N)` returns frame N's AU, which is
stamped `seq=N`, sent, and booked into `inflight` + `_send_times[N]`. The browser ACKs
`{seq, displayed}`; the server pops `_send_times[seq]` for RTT and clears `inflight`. That is
only correct if the bytes out of `encode(frame_N)` really are frame N's AU.

A pipelined hardware encoder breaks that: with output delay `k`, the first `k` `encode()`
calls return *nothing* (filling the pipeline), then a later call returns an *earlier* frame's
AU. Stamping the *current* call's `seq` would mislabel it by the pipeline depth, corrupting
RTT, `displayed`, and `inflight`.

The fix (and what this feature implements) is **token-based seq attribution**: the `seq` is
carried *through* the encoder as an opaque per-frame token and **recovered on the way out**,
so a payload always carries the seq of the frame it actually encoded — regardless of depth.
Each backend already has a per-frame token channel:

| Backend | Token channel |
| --- | --- |
| `pdum.vtenc` (VideoToolbox) | `VTCompressionSessionEncodeFrame` **`sourceFrameRefCon`** → echoed on the output `CMSampleBuffer` |
| `pdum.nvenc` (NVENC SDK) | in-order FIFO in the binding † (output order == input order) |
| `h264_cpu` (PyAV/libx264) | `VideoFrame.pts` → `Packet.pts` |

No-B-frames is still required (the browser-side FIFO assumes output order == input order);
that invariant is unchanged — and on NVENC it is also what makes seq recovery work (see †).

> † NVENC does expose `NV_ENC_PIC_PARAMS.inputTimeStamp`, but NVIDIA's vendored `NvEncoder`
> helper **overwrites it** with its own monotonic counter (`NvEncoder_130.cpp` /
> `_121.cpp`), and `packages/nvenc/third_party/` is kept verbatim. So the seq cannot ride
> `inputTimeStamp`. Instead, because `frameIntervalP=1` guarantees output order == input
> order, the binding recovers each AU's seq from a FIFO of the tags it pushed at `submit()`
> — equivalent, and independent of the SDK's internal timestamp.

## How to use it

```python
display = await rfb.serve(1920, 1080, port=8765, encode_pipeline_depth=2)
```

`encode_pipeline_depth`:

- **`0` (default)** — synchronous 1-in-1-out. Lowest latency. The only mode that was load-
  bearing before this feature, and still the right default.
- **`> 0`** — opt into the pipelined path on backends that implement it. The number is the
  requested depth (mapped to NVENC's `extra_output_delay`); the realized depth is
  backend-determined.

It is per-stream, so a hub can mix modes:

```python
server = await rfb.serve_server(port=8765)
server.add_stream("interactive", 1280, 720)                          # depth 0 (default)
server.add_stream("recorder", 3840, 2160, encode_pipeline_depth=4)   # throughput
```

The browser needs no changes — payloads still arrive in `seq` order with correct keyframes.

## The trade-off

- **Latency.** Pipelining *adds* ≈ `depth / fps` of glass-to-glass delay (the encoder holds
  `depth` frames before the first AU emerges). At 60 fps, depth 2 ≈ 33 ms of extra input lag
  — exactly what an interactive viewer feels. This is why the default is `0`.
- **Throughput.** On a backend whose `EncodeFrame` is genuinely asynchronous, pipelining lets
  the HW encoder keep several frames in flight and overlaps encode with render/convert, so
  sustained fps rises. This is the entire point of the knob.
- **Latest-frame-wins.** With depth `k`, up to `k` already-submitted frames are in the
  encoder and will be sent even if newer frames arrive — so backpressure's "drop stale, send
  the newest" guarantee is weakened by `k` frames. The wire is still bounded by `max_inflight`
  (the drop check counts *sent-but-unacked* payloads, independent of the encoder pipeline).

## Measured: which backends actually benefit

### VideoToolbox (macOS) — correct, but **no throughput win**

VideoToolbox's low-latency rate control (`kVTCompressionPropertyKey_…EnableLowLatencyRateControl`)
is **synchronous by design**: `VTCompressionSessionEncodeFrame` returns each frame's AU
promptly even without `CompleteFrames`, so the pipeline never fills. Apples-to-apples,
encoder-only (same NV12 input, only `encode()` vs `submit()` differs;
`examples/mlx_vt_bench.py --compare-pipeline`, Apple Silicon, MLX 0.31):

| Resolution | sync `encode()` fps | pipelined `submit()` fps | speedup | max depth |
| ---------- | ------------------- | ------------------------ | ------- | --------- |
| 1280×720   | 179 | 178 | 0.99× | 0 |
| 1920×1080  | 160 | 166 | 1.04× | 0 |
| 2560×1440  | 98  | 102 | 1.04× | 0 |
| 3840×2160  | 49  | 49  | 0.99× | 0 |

Depth stays **0** and throughput is unchanged. Disabling low-latency RC *does* unlock real
pipeline depth (~8), but it is *slower* overall (≈100 fps vs 160 at 1080p) — so it is not
worth doing. **On VideoToolbox, 1-in-1-out is not just the safe default, it is the optimal
one.** The pipelined path still runs correctly (recovered-seq attribution is exercised and
tested), it just confers no speedup — so there is no reason to set `encode_pipeline_depth > 0`
on macOS.

### NVENC (Linux/CUDA) — where it pays off

NVENC is built to pipeline: `extra_output_delay > 0` keeps several frames in flight, so
`EncodeFrame` returns without blocking on the just-submitted frame's bitstream lock and the
encode overlaps the next frame's convert/copy. This is the backend the feature exists for,
and it is **implemented**: `pdum.nvenc.NvencEncoder.submit()`/`flush_pipeline()` (the PyAV-free
SDK binding) feed `NvencGpuPdumEncoder(pipeline_depth=…)`, and `_nvenc_gpu_pdum_factory`
forwards the kwarg, so `serve(encode_pipeline_depth=k)` maps straight to NVENC
`extra_output_delay=k`. The synchronous `encode()`/`flush()` bytes are byte-for-byte
unchanged (depth `0` is still the default and the low-latency path).

Encoder-only, same CUDA NV12 input, differing only in `encode()` (sync) vs `submit()`
(pipelined, `extra_output_delay=4`) — `examples/nvenc_pipeline_bench.py`, RTX 4090 Laptop,
CUDA 13, 300 frames + 30 warmup, 30 fps target:

| Resolution | sync `encode()` fps | pipelined `submit()` fps | speedup | max depth |
| ---------- | ------------------- | ------------------------ | ------- | --------- |
| 1280×720   | ~800 | ~1250 | ~1.5× | 4 |
| 1920×1080  | 610  | 722   | 1.20× | 4 |
| 2560×1440  | 373  | 415   | 1.11× | 4 |
| 3840×2160  | 176  | 187   | 1.06× | 4 |

The realized depth is a genuine **4** (max `submitted − emitted`), so the recovered-seq token
is carried across a real pipeline — the point of the exercise. The speedup is largest where
per-frame fixed latency (the bitstream lock) dominates and shrinks toward 4K where the GPU
encode compute *is* the bottleneck (less idle to hide); in the live server the overlap also
covers render/convert, so the real-workload gain is at least this. The cost is the usual
`depth / fps` of added latency (depth 4 @ 30 fps ≈ 133 ms) — which is why the default stays
`0`. Correctness (recovered-seq order, no loss through dropped/gappy seqs, decode-back, and
max depth ≥ 1) is covered by `tests/test_nvenc_gpu_pdum.py`.

### libx264 / PyAV backends

`h264_cpu`, `nvenc_cpu`, and `nvenc_gpu_pyav` currently drop `pipeline_depth` and run
synchronously (only the PyAV-free `nvenc_gpu_pdum` SDK path implements pipelining). The `pts`
token channel exists to add it later if a throughput case appears; it has not been needed.

## See also

- [`encoder_sync_and_seq_attribution.md`](proposals/completed/encoder_sync_and_seq_attribution.md) — the design
  note this feature implements (why 1-in-1-out is load-bearing, the two correlation concerns,
  the token-recovery plan).
- [`pipelined_encode_nvenc_impl.md`](proposals/completed/pipelined_encode_nvenc_impl.md) — as-built
  implementation notes for the NVENC side.
- [`internals.md`](internals.md#pipelined-encode-token-based-seq-attribution) — how the
  pipelined path threads through the binding, wrapper, and session.
- [`mlx_metal_videotoolbox_encoder_design.md`](proposals/completed/mlx_metal_videotoolbox_encoder_design.md) — the
  VideoToolbox shim, including the zero-copy measurement (the input-side analog of this
  output-side investigation).
