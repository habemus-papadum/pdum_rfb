# Apple Metal / VideoToolbox encoding (macOS)

On **Apple Silicon** you render with **MLX** and encode with the platform hardware
H.264 encoder — Apple **VideoToolbox** (`VTCompressionSession`). This is the macOS
counterpart to the Linux [CUDA→NVENC](gpu_zerocopy.md) path: `serve(gpu=True)`
selects it, and the **RGB(A)→NV12 color conversion runs on the GPU** with a custom
`mx.fast.metal_kernel` so it never touches the CPU.

For a render-on-GPU scientific pipeline on a Mac this keeps the whole frame on the
GPU through conversion and hands the encoder a host-visible NV12 view — on unified
memory the residual copy is negligible, so the CPU is freed for your own work.

Under the hood it rides the sibling workspace package **`habemus-papadum-vtenc`**
(`import pdum.vtenc`) — a thin pybind11 / Objective-C++ binding over
`VTCompressionSession` that takes host NV12 and returns low-latency H.264 **Annex B**,
with **no PyAV and no ffmpeg**. It mirrors `pdum.nvenc`.

## Quick start

```python
import asyncio, mlx.core as mx, pdum.rfb as rfb

async def main():
    # gpu=True on macOS selects the VideoToolbox encoder (validated at startup).
    display = await rfb.serve(1920, 1080, port=8765, gpu=True)
    try:
        while True:
            for ev in display.poll_events():
                ...  # handle input
            rgba = render_scene_mlx(state)   # an (H, W, 4) uint8 mx.array (on the GPU)
            display.publish(rgba)            # recognized as a memory="metal" frame
            await asyncio.sleep(1 / 60)
    finally:
        await display.aclose()

asyncio.run(main())
```

That is the whole integration. Note two differences from the CUDA path:

- **No context-sharing call.** There is no `enable_cuda_context_sharing()` analog —
  unified memory means there is no separate device context to reconcile.
- **MLX is lazy.** `publish()` **materializes** the render on the calling (loop)
  thread (`mx.eval` under the hood), so the encoder's worker thread reads an already
  computed buffer. You do not have to call `mx.eval` yourself before `publish()`.

## How it compares to the CUDA→NVENC path

| | macOS (this page) | Linux ([gpu_zerocopy](gpu_zerocopy.md)) |
| --- | --- | --- |
| Hardware encoder | Apple **VideoToolbox** | NVIDIA **NVENC** |
| Package | `pdum.vtenc` (`[mac-vt]`) | `pdum.nvenc` (`[gpu-nvenc-sdk]`) / PyAV≥18 |
| GPU frame producer | **MLX** `mx.array` (`memory="metal"`) | CuPy/PyTorch/JAX DLPack (`memory="cuda"`) |
| RGB→NV12 conversion | `mx.fast.metal_kernel` on the GPU | CuPy `RawKernel` on the GPU |
| `serve(gpu=True)` picks | `vtenc` | `nvenc_gpu_pdum`, else `nvenc_gpu_pyav` |
| Extra deps beyond the OS | just MLX | CuPy (+ PyAV≥18 for the PyAV route) |
| Input **zero-copy** worth it? | **No** — unified memory, no PCIe upload to remove | Yes — it removes the host→device upload |

The key architectural difference is **unified memory**. The CUDA zero-copy win comes
from eliminating the PCIe host→device upload (2.4–4.3× there). On Apple Silicon that
upload does not exist, so the lever is different: keep the **color conversion** on the
GPU (a real win) but do not bother chasing input zero-copy (measured to buy ≤2 %; see
[below](#the-two-measured-dead-ends-input-zero-copy-and-pipelining)).

## How it works

- **`RawFrame.memory == "metal"`** carries the MLX array; `Display.publish()` tags an
  `mx.array` automatically (the type already modelled a Metal frame).
- On `publish()`, `pdum.rfb.metal.materialize()` forces the lazy MLX graph on the
  **loop thread**. (MLX binds a lazy graph to the submitting thread's default stream,
  so it must be evaluated where it was built — not on the encode worker thread.)
- Per viewer, the **`VideoToolboxEncoder`** (`encoders/vtenc.py`, registered
  `"vtenc"`) converts **RGB(A)→NV12 on the GPU** (`metal.rgb_to_nv12`), hands the
  binding a host NV12 view (`to_host_nv12` — unified memory makes `np.asarray` a
  near-zero-copy handoff), and `VtEncoder` memcpys it into an encoder-owned
  `CVPixelBuffer` and encodes.
- Output is **Annex B** (start codes, in-band SPS/PPS on every IDR), **no B-frames**
  (output order == input order), **synchronous 1-in-1-out** (each `encode()` returns
  its own frame's access unit — required for correct `seq` attribution), **BT.601
  limited-range** VUI (byte-identical coefficients to `gpu.rgb_to_nv12`, so a
  VideoToolbox stream and a CUDA/NVENC stream tag color the same way).
- The advertised **codec string is derived from the emitted SPS**
  (`VtEncoder.codec_string`), not a constant — VideoToolbox picks the level from the
  resolution (1080p is `avc1.420028`, 720p `avc1.42001F`).
- Wire format, forced-keyframe handling, and backpressure are **inherited unchanged**
  — the browser side needs nothing new.

## Measured performance (Apple Silicon)

Per-frame breakdown (M-series, macOS 26, MLX 0.31; moving-bands pattern, 10 Mbps),
from `examples/mlx_vt_bench.py`:

| Resolution | render (MLX) | convert RGB→NV12 (MLX) | copy → CVPixelBuffer | VT encode | `encode()` total | copy % | fps |
| ---------- | -----------: | ---------------------: | -------------------: | --------: | ---------------: | -----: | --: |
| 1280×720   | 0.99 ms      | 0.36 ms                | **0.041 ms**         | 5.61 ms   | 5.67 ms          | 0.7 %  | 142 |
| 1920×1080  | 1.08 ms      | 0.44 ms                | **0.106 ms**         | 5.83 ms   | 5.97 ms          | 1.8 %  | 134 |
| 2560×1440  | 1.15 ms      | 0.52 ms                | **0.187 ms**         | 9.33 ms   | 9.55 ms          | 2.0 %  | 89  |
| 3840×2160  | 1.28 ms      | 0.63 ms                | **0.383 ms**         | 18.92 ms  | 19.35 ms         | 2.0 %  | 47  |

Two things to read off it:

1. **Doing the color conversion on the GPU is the win.** Sub-millisecond on the GPU
   (≈0.3–0.6 ms) versus **~6.6 ms** for the equivalent numpy/CPU conversion at 1080p
   — a ~23× reduction that also frees a CPU core. This is what `serve(gpu=True)` +
   publishing an `mx.array` buys you over publishing a plain numpy array.
2. **The encode is a near-flat ~5.6 ms floor at 720p and 1080p** before compute
   dominates at 1440p/4K — i.e. at typical sizes the cost is VideoToolbox's
   synchronous `CompleteFrames` latency, not pixel throughput.

## Requirements & install

`serve(gpu=True)` on macOS needs:

1. **macOS on Apple Silicon** — the VideoToolbox/CoreVideo/CoreMedia frameworks are
   system-provided; the wheel bundles no Apple binaries.
2. **The `[mac-vt]` extra** — `habemus-papadum-vtenc` / `pdum.vtenc`, the hardware
   H.264 binding. Gated at runtime by `pdum.rfb.encoders.vtenc.vtenc_available()`
   (macOS + `pdum.vtenc` importable + VideoToolbox opens an H.264 session).
3. **MLX** — for the GPU RGB→NV12 path (the `mac-dev` group). Gated by
   `pdum.rfb.metal.mlx_available()`.

```bash
pip install 'habemus-papadum-rfb[mac-vt]'      # the VideoToolbox encoder
pip install mlx                                # the GPU frame producer (dev group: mac-dev)
# or, from the repo, both at once:
uv sync --extra mac-vt --group mac-dev
```

Verify with the CLI:

```bash
pip install 'habemus-papadum-rfb[cli]'
pdum-rfb doctor
```

On an Apple Silicon Mac with the extras installed, `doctor` reports:

```
 Platform                              ✓ ok   Darwin/arm64  (Apple Silicon: VideoToolbox HW H.264)
 vtenc — Apple VideoToolbox (H.264)    ✓ ok   available
 mlx — Apple Metal (GPU RGB→NV12)      ✓ ok   available
 → Recommended: vtenc — Apple VideoToolbox: hardware H.264 on macOS (with MLX for GPU RGB→NV12)
```

> **MLX is optional.** Without MLX you can still `serve(gpu=True)` and publish a plain
> numpy RGBA array — it just falls back to the **CPU** RGB→NV12 conversion (fine at
> ≤720p, a bottleneck at 1080p+). Convert in MLX and publish the `mx.array` to get the
> GPU path.

## Publishing frames

Three equivalent producers, cheapest-effort first:

```python
# 1) Plain RGBA on the GPU (recommended) — publish() converts RGB→NV12 on the GPU.
rgba = render_scene_mlx(state)                 # (H, W, 4) uint8 mx.array
display.publish(rgba)

# 2) Pre-converted NV12 — skip even the RGB→NV12 step if you already produce NV12.
nv12 = rfb.metal.rgb_to_nv12(rgba)             # contiguous (H+H//2, W) mx.array on the GPU
display.publish(rfb.metal.metal_frame(nv12))   # tagged memory="metal", pixel_format="nv12"

# 3) Plain numpy (works everywhere, no MLX) — CPU RGB→NV12 conversion.
display.publish(numpy_rgba)
```

Publish a **fresh** MLX array per frame and keep it alive (and evaluated) until it is
encoded — viewers share the reference and read it asynchronously (same rule as the
CUDA path). The opt-in [`own_frames`](guide_python.md#frame-ownership-memory-model)
copy mode is **not supported for Metal** (it raises): MLX arrays are functionally
immutable — a render yields a *new* array — so the borrow contract already holds and
there is nothing to copy. Still-after-settle is likewise safe on the Metal path for the
same reason (its per-session snapshot skips Metal frames).

## Image-only viewers still work

A viewer that negotiates the **image** transport (no WebCodecs) on a Metal-publishing
display is handled automatically: its image encoder is wrapped in
`metal.MetalHostFrameAdapter`, which downloads each Metal frame to host `rgb24` (an
NV12 frame is converted back to RGB on the host) before encoding — exactly like the
CUDA path's `HostFrameAdapter`. GPU mode otherwise targets WebCodecs (H.264) viewers.

## The two measured dead-ends: input zero-copy and pipelining

Both were prototyped, measured, and **not pursued** — they exist for parity/correctness
but confer no speedup on Apple Silicon. Details in the
[design doc](proposals/completed/mlx_metal_videotoolbox_encoder_design.md).

- **Input zero-copy** (wrapping MLX's unified-memory buffer as the `CVPixelBuffer`
  backing, avoiding the host→`CVPixelBuffer` copy) buys **≤2 %** of frame time — the
  residual copy is a sub-0.4 ms RAM `memcpy` even at 4K, because unified memory
  already removed the expensive part (the PCIe upload the CUDA path eliminates). The
  v1 host-copy path stays.
- **Pipelined encode** (`serve(encode_pipeline_depth=k)`) is **correct but not faster**
  here: VideoToolbox's low-latency rate control is synchronous, so depth > 0 measures
  ~1.0× at every resolution. Synchronous 1-in-1-out stays optimal on macOS. The knob
  exists for the NVENC backend, where `extra_output_delay` pipelining pays off. See
  [Pipelined encode](pipelined_encode.md).

## Using the encoder directly (no `serve()`)

`pdum.vtenc.VtEncoder` is a standalone hardware H.264 encoder — useful for offline
encode or a custom transport:

```python
import numpy as np
from pdum.vtenc import VtEncoder, supported

assert supported()                                        # VideoToolbox opens H.264
enc = VtEncoder(1920, 1080, codec="h264", fps=30, gop=30, bitrate=12_000_000)
nv12 = np.zeros((1080 * 3 // 2, 1920), np.uint8)          # contiguous NV12 (Y then UV)
# ... fill nv12 (numpy, or an evaluated MLX mx.array — both expose the buffer protocol) ...
annexb = enc.encode(nv12, force_idr=True)                 # bytes; H.264 Annex B
annexb += enc.flush()
print(enc.codec_string)                                   # e.g. "avc1.420028" (from the SPS)
enc.close()
```

`encode()` accepts any contiguous `(H*3//2, W)` `uint8` buffer-protocol object; for an
MLX array, `mx.eval(frame)` first (MLX is lazy). See the
[`pdum.vtenc` README](https://github.com/habemus-papadum/pdum_rfb/blob/main/packages/vtenc/README.md).

## API

`pdum.rfb.metal` lazy-imports MLX, so importing it is always safe.

| Symbol | Purpose |
| ------ | ------- |
| `metal.mlx_available()` | `True` iff MLX (Apple Metal GPU) is usable in this process (cached). |
| `metal.rgb_to_nv12(rgb)` | Metal `(H,W,3\|4)` mx.array → contiguous NV12 `(H+H//2, W)` on the GPU (custom kernel). |
| `metal.to_host_nv12(array)` | Evaluate an NV12 mx.array → contiguous host numpy view (near-zero-copy). |
| `metal.metal_frame(array, *, pixel_format="auto", ...)` | Wrap an MLX array as a `memory="metal"` `RawFrame` for `publish()` (the Metal analog of `gpu.cuda_frame`). |
| `metal.to_host_rgb(frame)` | Download a Metal frame to host `rgb24` (used by the image fallback). |
| `metal.MetalHostFrameAdapter(inner)` | Wrap a host encoder so it tolerates Metal frames (downloads first). |
| `encoders.vtenc.VideoToolboxEncoder` | The `EncoderBackend` (registered `"vtenc"`). |
| `encoders.vtenc.vtenc_available()` | `True` iff VideoToolbox H.264 is usable (macOS + `pdum.vtenc` + a real session opens). |
| `pdum.vtenc.VtEncoder` / `supported()` | The standalone binding: host NV12 → H.264 Annex B. |

`publish()` accepts an MLX `(H,W,3\|4)` array directly (or a `metal_frame` for NV12),
and `serve(gpu=True)` selects `VideoToolboxEncoder` for every WebCodecs viewer.

## Testing & examples

- **`examples/mlx_vt_stream.py`** — end-to-end: two Metal kernels render RGBA + convert
  RGB→NV12, `VtEncoder` encodes, PyAV decodes back. `--check` for a headless verify,
  `--out scene.h264` to also write a playable file.
- **`pdum-rfb benchmark`** (and `python -m pdum.rfb.benchmark`) — auto-includes a
  `vtenc` row on macOS (`vtenc-gpu` when MLX converts RGB→NV12 on the GPU, else
  `vtenc-cpu`), decoded back with PyAV for real PSNR, alongside the image / libx264
  rows. A single encode-time figure per row; use `mlx_vt_bench.py` for the
  render/convert/copy breakdown.
- **`examples/mlx_vt_bench.py`** — the per-frame breakdown above (`--compare-pipeline`
  contrasts synchronous vs pipelined depth).
- **`tests/test_vtenc.py`** — numpy NV12 → encode → PyAV decode-back (skips off macOS).
- **`pdum-rfb demo`** — the interactive harness includes an **MLX/Metal shader** scene
  and lets you switch the encode backend live (`image ⇄ libx264 ⇄ VideoToolbox ⇄
  NVENC`) on one WebSocket. See [Demo harness](demo.md).

## Caveats

- **Even dimensions only** (NV12). A resize rebuilds the encoder and forces a keyframe.
- **H.264 only.** HEVC is a follow-up.
- **One `VTCompressionSession` per encoder instance**, fixed resolution.
- **MLX is lazy** — `publish()` materializes the render on the loop thread; if you
  build frames elsewhere, `mx.eval` them before handing them off.
- The browser must support **WebCodecs H.264**; image-only viewers fall back
  transparently (see above).
