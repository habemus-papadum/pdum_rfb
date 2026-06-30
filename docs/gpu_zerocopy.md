# Zero-copy GPU encoding (CUDA → NVENC)

Stream a **GPU-resident** framebuffer straight to NVENC with **no host copy**: a
CUDA NV12 (or RGB) buffer — a CuPy / PyTorch / any `__dlpack__` tensor — is handed
to `h264_nvenc` via PyAV's `VideoFrame.from_dlpack`, and the encoder reads device
memory directly. This is the GPU counterpart to the host
[`NvencCpuEncoder`](guide_python.md), which uploads host `rgb24` and reformats to
`yuv420p` on the CPU first.

For a render-on-GPU scientific pipeline this removes the CPU color-conversion and
the PCIe upload from every frame and frees the CPU entirely.

## Measured payoff

Per-frame encode latency on an RTX 4090 Laptop GPU (moving gradient, vbr,
`delay=0`), CPU-origin (host `rgb24` → CPU `yuv420p` reformat → upload → encode)
vs GPU zero-copy (device RGB → on-GPU NV12 → `from_dlpack` → encode):

| Resolution | RGB→NV12 (GPU) | GPU encode (zero-copy) | GPU total | GPU fps | CPU-origin | CPU fps | speed-up |
| ---------- | -------------- | ---------------------- | --------- | ------- | ---------- | ------- | -------- |
| 1280×720   | 0.009 ms       | 1.36 ms                | 1.37 ms   | 730     | 3.25 ms    | 307     | 2.4×     |
| 1920×1080  | 0.014 ms       | 2.49 ms                | 2.50 ms   | 400     | 7.26 ms    | 138     | 2.9×     |
| 2560×1440  | 0.021 ms       | 3.52 ms                | 3.54 ms   | 282     | 12.73 ms   | 79      | 3.6×     |
| 3840×2160  | 0.057 ms       | 7.08 ms                | 7.08 ms   | 141     | 30.53 ms   | 33      | 4.3×     |

The NVENC kernel itself is GPU-bound either way; the win is removing the CPU
`rgb→yuv` reformat (libswscale, single-threaded — brutal at 4K) and the per-frame
PCIe upload (~0.5 ms at 1080p, ~2.2 ms at 4K). Reproduce with
`python -m pdum.rfb.benchmark --gpu` (see [Benchmark](#benchmark)).

## What NV12 is

NVENC's native input is **NV12**: YUV 4:2:0, 8-bit, *semi-planar*.

- **Y (luma)** — full resolution, `W×H` bytes.
- **UV (chroma)** — half resolution in both axes, one **interleaved** plane of
  `U,V,U,V…` (`(H/2)×W` bytes). Each chroma sample is shared by a 2×2 pixel block.

Total `1.5 bytes/pixel` (vs 3 for RGB). "Semi-planar" = Y separate, U/V interleaved
(NV12), unlike `yuv420p`/I420's three separate planes. Critically, NVENC wants NV12
as **one contiguous allocation** — Y plane, then the UV plane at byte offset
`pitch·height` — because it reads UV relative to the Y base pointer. This module's
[`rgb_to_nv12`](#api) produces exactly that layout; [`nv12_planes`](#api) slices it
back into the two DLPack planes.

## Quick start

```python
import asyncio, cupy as cp, pdum.rfb as rfb

# 1) BEFORE any framework's first CUDA op (CuPy/PyTorch/JAX): share the device
#    primary context with FFmpeg. This pokes the CUDA driver directly (no CuPy),
#    so it must run before anything activates the primary context — otherwise the
#    flags don't take effect.
rfb.enable_cuda_context_sharing()

async def main():
    # 2) gpu=True selects the zero-copy CUDA→NVENC encoder (validated at startup).
    display = await rfb.serve(1920, 1080, port=8765, gpu=True)
    try:
        while True:
            for ev in display.poll_events():
                ...  # handle input
            frame_rgb = render_on_gpu()           # a CuPy (H, W, 3) uint8 array
            display.publish(frame_rgb)            # zero-copy: stays on the GPU
            await asyncio.sleep(1 / 60)
    finally:
        await display.aclose()

asyncio.run(main())
```

Publish a CuPy `(H, W, 3)` array directly, or — to skip even the RGB→NV12 step —
publish an already-NV12 frame:

```python
nv12 = rfb.gpu.rgb_to_nv12(frame_rgb)             # contiguous (H+H//2, W) on GPU
display.publish(rfb.gpu.cuda_frame(nv12, pixel_format="nv12", height=1080))
```

Any framework works as long as the tensor exposes `__cuda_array_interface__` or a
CUDA `__dlpack__` — **CuPy, PyTorch, and JAX** all do, and all run on the device
**primary context**, so the pointer FFmpeg/NVENC sees is valid (that's what
[`enable_cuda_context_sharing`](#api) guarantees; it operates on the primary context
via the CUDA driver, not on any one library). **One caveat:** a framework that
creates its *own* non-primary context — e.g. Numba's CUDA target, which calls
`cuCtxCreate` rather than retaining the primary context — produces pointers that
live in a different context and can't be registered, even after the call. CuPy,
PyTorch, and JAX are not in that category.

## Requirements

`pdum.rfb.gpu.cuda_zerocopy_available()` returns `True` only when **all** hold (it
runs an actual one-frame encode to be sure, and caches the result):

1. **CuPy** — `cupy-cuda13x` / `cupy-cuda12x` (cp314 wheels exist; works on 3.14).
2. **An NVENC-capable GPU + driver** — same gate as the host NVENC backend
   (`pdum.rfb.encoders.nvenc.nvenc_cpu_available()`).
3. **PyAV that can *encode* CUDA frames — PyAV ≥ 18.** `from_dlpack` (frame
   *creation*) is in 17.0, but feeding a CUDA frame to an encoder — adopting the
   frame's `hw_frames_ctx` before `avcodec_open2` — lands in **18.0**
   ([PyAV #2199](https://github.com/PyAV-Org/PyAV/issues/2199)), unreleased at time
   of writing (the fix is on `main`).

On PyAV 17.x the encode raises `avcodec_open2(...) returned 22; hw_frames_ctx must
be set when using GPU frames as input`.

## Installing it today (before PyAV 18.0 ships on PyPI)

CuPy installs normally (`pip install habemus-papadum-rfb[gpu-cuda13]`, or
`[gpu-cuda12]` for CUDA 12). The only catch is **PyAV ≥ 18**, which isn't on PyPI
yet. Three paths, easiest first; all land in your active env (or `$PYTHON`):

**1. Prebuilt self-contained wheel (recommended).** A wheel with a CUDA-enabled
ffmpeg bundled in — no system ffmpeg, no compiler, no env vars. Host it on a GitHub
release (see *Building & hosting* below), then:

```bash
PYAV_WHEEL_URL=https://github.com/<owner>/<repo>/releases/download/<tag>/av-...whl \
  ./scripts/install-gpu.sh           # installs the wheel + CuPy, then self-tests
# or directly:  uv pip install <that-url> cupy-cuda13x
```

**2. Build from source (one command).** No prebuilt wheel needed — the script
fetches a CUDA ffmpeg (a BtbN LGPL shared build) and builds PyAV from a pinned
commit, baking an rpath so **no `LD_LIBRARY_PATH`** is needed at runtime:

```bash
./scripts/install-gpu.sh             # ~1 min the first time; uv caches the build
# CUPY_PACKAGE=cupy-cuda12x ./scripts/install-gpu.sh   # for a CUDA 12 toolkit
```

**3. When PyAV 18.0 is released:** add `"av>=18"` to the `[gpu-cuda13]`/`[gpu-cuda12]`
extras and it collapses to a one-step `pip install habemus-papadum-rfb[gpu-cuda13]`
— the 18.0 wheel bundles a CUDA-capable ffmpeg, so no build and no system ffmpeg.

### Building & hosting the wheel (maintainers)

`scripts/build-cuda-av-wheel.sh` builds the self-contained wheel(s):

```bash
PYTHON_VERSIONS="3.12 3.13 3.14" ./scripts/build-cuda-av-wheel.sh   # -> dist/cuda-wheels/
gh release create gpu-av18-<date> dist/cuda-wheels/av-*.whl \
  --title "PyAV 18 (CUDA/NVENC) wheels" --notes "Self-contained; bundles LGPL ffmpeg."
```

It links PyAV against a BtbN **LGPL** ffmpeg (has `h264_nvenc` + the CUDA hwcontext,
`--disable-libx264` ⇒ no GPL components) and runs `auditwheel repair` to bundle the
ffmpeg `.so`s (tagged `manylinux_2_28` ⇒ installs on RHEL8 / Ubuntu 18.10+ and
newer). `libcuda`/`libnvidia-encode` are **not** bundled — they come from the host
driver, as they must. **Licensing:** the bundled ffmpeg is LGPL, so redistributing
the wheel carries LGPL obligations (offer the corresponding ffmpeg source / build
config). Hosting in this repo's GitHub **Releases** (not committed to the tree) is
the simplest option; a PEP 503 index on GitHub Pages is a later nicety.

## Two gotchas the library handles for you

### One shared CUDA context

CuPy uses the device **primary** context. FFmpeg's CUDA hwcontext (`primary_ctx=1`)
expects that context to have been created with `CU_CTX_SCHED_BLOCKING_SYNC` flags.
If CuPy activates it first with the default (auto) flags:

- `primary_ctx=True` fails with *"Primary context already active with incompatible
  flags"*; and
- a separate `primary_ctx=False` context can't register CuPy's pointers — NVENC
  *"resource register failed (23)"*, because a device pointer from one context
  isn't valid in another on the same device.

`enable_cuda_context_sharing()` pre-sets the flags (via the CUDA driver
`cuDevicePrimaryCtxSetFlags`). **Call it once, before any CuPy/PyTorch CUDA op**
(importing CuPy is fine; the first allocation/op is what activates the context).
`serve(gpu=True)` and the encoder call it defensively too, but if CuPy has already
run, it is too late for that process.

### NV12 must be one contiguous allocation

Pass NVENC two *separate* CuPy arrays for Y and UV and registration fails. Allocate
one buffer and slice views — which is what `rgb_to_nv12` / `nv12_planes` do:

```python
nv12 = cp.empty((H + H // 2, W), cp.uint8)   # one allocation
y, uv = nv12[:H], nv12[H:]                    # views; uv at base + W*H
```

## RGB → NV12 conversion options

NVENC needs YUV, so a GPU RGB buffer must be converted first. Cheapest-effort first:

1. **A custom CuPy `RawKernel`** — what `pdum.rfb.gpu.rgb_to_nv12` uses (BT.601
   limited range). ~20 lines of CUDA C, no extra dependency, ~0.01 ms at 1080p.
   **Recommended** — the conversion is so cheap that nothing else buys anything.
2. **NPP** (`nppiRGBToNV12_*`) — NVIDIA's prebuilt image primitives, ships with
   CUDA; fast and battle-tested but adds an NPP binding.
3. **CV-CUDA / `nvcv`** — `cvcuda.cvtcolor`; a heavier dependency, worthwhile only
   if you already use it.
4. **PyNvVideoCodec / VPF** — bundle convert *and* encode, but have no cp314 wheel
   (see [the NVENC-source route](#alternative-the-nvenc-source-route)).

## Can we avoid building PyAV from source on `< 18`?

Short answer: **no pure-Python monkey-patch exists; you must build PyAV from
source** (or wait for the 18.0 wheel). Investigated and ruled out:

- **`HWAccel` (setting `hw_device_ctx`)** — PyAV *can* set the encoder's
  `hw_device_ctx` from Python via `HWAccel`, but NVENC explicitly rejects it for
  GPU input: *"hw_frames_ctx must be set when using GPU frames as input"*. It needs
  `hw_frames_ctx` specifically.
- **A `ctypes` poke at `avctx->hw_frames_ctx`** — PyAV exposes **no** Python handle
  to the underlying `AVCodecContext` / `AVFrame` pointers, and Cython cdef-object
  offsets are not stable ABI. Not viable.

So `< 18` needs a build. Good news: **no custom FFmpeg is required** — the stock
PyPI `av` wheel's bundled ffmpeg already has the CUDA hwcontext (it's auto-enabled
by the nv-codec-headers + nvenc dependency; it just isn't a separate
`--enable-cuda` token, which is why `from_dlpack(primary_ctx=False)` works on the
stock wheel today). You only need to rebuild *PyAV* against an ffmpeg dev tree.

This is what [`scripts/install-gpu.sh`](#installing-it-today-before-pyav-180-ships-on-pypi)
automates (Option A). The manual forms, for reference:

### Option A — build PyAV `main` / a pinned commit (the official fix)

```bash
# needs a CUDA ffmpeg dev tree on PKG_CONFIG_PATH (a BtbN LGPL/GPL "shared" release —
# no compiling ffmpeg yourself); LDFLAGS bakes an rpath so no LD_LIBRARY_PATH at runtime
PKG_CONFIG_PATH=/path/to/ffmpeg/lib/pkgconfig LDFLAGS="-Wl,-rpath,/path/to/ffmpeg/lib" \
  uv pip install --no-cache --no-binary av "av @ git+https://github.com/PyAV-Org/PyAV@main"
```

> uv caches built wheels by git commit, **not** by the ffmpeg you link against — so
> use `--no-cache` (or `--refresh`) when (re)building against a specific ffmpeg, or a
> stale wheel may be reused silently.

### Option B — the minimal patch on 17.1.0 (pin to a known version)

Two edits to the PyAV sdist, then build from source. They are exactly what 18.0
does ([#2199](https://github.com/PyAV-Org/PyAV/issues/2199)):

1. `include/avcodec.pxd` — declare the field (the cdef struct omits it):
   ```diff
            AVHWAccel *hwaccel
            AVBufferRef *hw_device_ctx
   +        AVBufferRef *hw_frames_ctx
    ```
2. `av/video/codeccontext.py` — adopt a hardware input frame's `hw_frames_ctx`
   before the encoder is opened:
   ```python
   @cython.cfunc
   def _prepare_and_time_rebase_frames_for_encode(self, frame: Frame):
       if (not self.is_open and frame is not None
               and frame.ptr.hw_frames_ctx and not self.ptr.hw_frames_ctx):
           self.ptr.hw_frames_ctx = lib.av_buffer_ref(frame.ptr.hw_frames_ctx)
       return CodecContext._prepare_and_time_rebase_frames_for_encode(self, frame)
   ```
   ```bash
   PKG_CONFIG_PATH=/path/to/ffmpeg/lib/pkgconfig uv pip install --no-binary av ./PyAV-17.1.0
   ```

Either way, `cuda_zerocopy_available()` flips to `True` and everything below works.

## API

All of `pdum.rfb.gpu` lazy-imports CuPy, so importing it is always safe.

| Symbol | Purpose |
| ------ | ------- |
| `enable_cuda_context_sharing(device_id=0)` | Pre-set primary-ctx flags so CuPy + FFmpeg share one context. **Call first.** |
| `cuda_zerocopy_available()` | `True` iff the full stack works (cached; runs a real encode). |
| `rgb_to_nv12(rgb, *, out=None)` | Device `(H,W,3)` → contiguous NV12 `(H+H//2, W)` (custom kernel). |
| `nv12_planes(packed)` | Slice contiguous NV12 into `(Y, UV)` DLPack-ready views. |
| `cuda_frame(array, *, pixel_format="auto", ...)` | Wrap a device tensor as a CUDA `RawFrame` for `publish()`. |
| `to_host_rgb(frame)` | Download a CUDA frame to host `rgb24` (used by the image fallback). |
| `HostFrameAdapter(inner)` | Wrap a host encoder so it tolerates CUDA frames (downloads first). |
| `NvencGpuPyavEncoder` | The `EncoderBackend` (registered as `"nvenc_gpu_pyav"`). |

`publish()` accepts a CuPy `(H,W,3|4)` tensor directly (or a `cuda_frame` for NV12),
and `serve(gpu=True)` selects `NvencGpuPyavEncoder` for every viewer.

## Architecture & integration

- `RawFrame.memory == "cuda"` (the type already modelled this) carries the device
  tensor; `Display.publish` tags CuPy/DLPack tensors automatically.
- `NvencGpuPyavEncoder` (`encoders/nvenc_gpu_pyav.py`) subclasses the host
  `H264CpuEncoder`, swapping only the input handling: it accepts a CUDA `nv12`
  frame (true zero-copy), a CUDA `rgb24`/`rgba8` frame (on-GPU convert first), or a
  host frame (uploaded then converted — a graceful fallback). It reuses one
  contiguous NV12 staging buffer (safe because `delay=0` consumes each frame before
  the next), and one persistent `CudaContext` so every frame shares the encoder's
  `hw_frames_ctx`.
- Wire format, Annex B packing, forced-keyframe handling, and backpressure are
  **inherited unchanged** — the browser side needs nothing new.
- **Image-only viewers** on a GPU-publishing display still work: their image
  encoder is wrapped in `HostFrameAdapter`, which downloads each CUDA frame to host
  `rgb24` (NV12 is converted on the GPU first). GPU mode otherwise targets
  WebCodecs (H.264) viewers.

## Benchmark

```bash
# CPU-origin vs GPU zero-copy, per resolution, with CUDA-event-timed conversion
python -m pdum.rfb.benchmark --gpu
```

Reports, per resolution: the RGB→NV12 conversion cost (timed with
`cupy.cuda.Event` markers), the zero-copy encode latency, and the CPU-origin
latency for comparison. Requires the full stack above.

## Alternative: the NVENC-source route

PyAV is the pragmatic backend (one dependency, no build once 18.0 ships). The other
route is **NVIDIA's own** binding to the Video Codec SDK:

- **PyNvVideoCodec / VPF** — takes CUDA arrays directly (DLPack / CAI), bundles its
  own color conversion, and bypasses ffmpeg entirely. But: **no cp314 wheel and no
  sdist** on PyPI, so it can't `pip install` on 3.14. Building from the Video Codec
  SDK source is possible (CUDA + `nvcc` are present on a dev box) but needs the SDK
  headers (`nvEncodeAPI.h`) and is a heavier, NVIDIA-version-coupled dependency.
- **A direct `ctypes`/`cffi` binding to `libnvidia-encode`** — no build step
  (dlopen the driver lib), maximal control, but a large amount of NVENC-API
  plumbing to maintain.

Trade-off: PyAV reuses our existing Annex-B / decode-back test infrastructure and
adds zero new Python dependencies; the NVENC-SDK route removes the ffmpeg layer and
the PyAV-18 dependency but adds a build step and a hand-maintained binding. If the
SDK source is available, the most interesting evaluation is whether a thin
PyNvVideoCodec build (or a minimal `cffi` shim) can match the PyAV path's latency
while accepting the *same* DLPack frames `gpu.cuda_frame` already produces — in
which case it could slot in behind the same `register_video_encoder("nvenc_gpu_pyav",
...)` seam.

## Caveats

- **Consumer GPUs** can transiently `EINVAL` (or rarely hard-fault) on rapid NVENC
  *session* open/close churn. Production uses one long-lived encoder per connection
  and is unaffected; the test suite retries and GCs between encoders.
- Publish a **fresh** device buffer per frame — viewers share the reference and may
  read it asynchronously (same rule as the host path).
- Even dimensions only (NV12), and `width ≥ 160` (NVENC minimum).
- The encoder uses device 0 and the primary context; multi-GPU selection is a
  future extension.
