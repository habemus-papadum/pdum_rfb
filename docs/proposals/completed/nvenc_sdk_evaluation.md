# NVIDIA Video Codec SDK encoder — evaluation & integration plan

This evaluates **PyNvVideoCodec** (NVIDIA's Python binding over the Video Codec SDK
encoder, `NvEncoderCuda`) as an alternative GPU H.264/HEVC backend for `pdum.rfb`,
versus the current PyAV `h264_nvenc` path. The source drop lives in
`vendor/PyNvVideoCodec_2.1.0/` (gitignored). The encode-only spike that proved this
out has since been **productionized** as the `packages/nvenc/` workspace package —
**`habemus-papadum-nvenc`** (`import pdum.nvenc`), published to PyPI, shipping both
NVENC 12.1 and 13.0 ABIs. For the PyAV path this complements, see
[GPU zero-copy encoding](../../gpu_zerocopy.md).

## TL;DR

- **PyAV suffices for now — keep it.** When PyAV 18.0 reaches PyPI, our GPU path
  collapses to a one-line `pip install`. PyNvVideoCodec is a viable *future*
  alternative backend, not a replacement.
- **It works on Python 3.14.** Upstream pins **pybind11 2.10.0** (no 3.14 support)
  and ships no cp314 wheel/sdist; bumping pybind11 to **3.0.4** builds clean. Proven
  by the spike — see [Spike results](#spike-results).
- **Its standout win: no PyAV at all.** The whole `scripts/install-gpu.sh` /
  self-contained-wheel apparatus exists only because PyAV 18 (the encode-side
  `hw_frames_ctx` wiring) isn't released. The SDK encoder sidesteps that entirely.
- **Cost: a heavier build** (CUDA toolkit + the vendored SDK) and a native
  extension we'd maintain. We carry no upstream edits — only a pybind11 bump.

## What it is (and what the encoder needs)

PyNvVideoCodec is a pybind11 binding over the SDK's `NvEncoderCuda` C++ helper,
which talks to `libnvidia-encode` **directly**. Structural facts verified in the
source:

- **The encode path is ffmpeg-free.** No `libav*` include anywhere in
  `PyNvEncoder.cpp` or the SDK `NvEncoder*` sources. ffmpeg is bundled only for the
  demux/decode/transcode side, which we don't need. `libnvidia-encode` is `dlopen`'d
  (not linked), so only `libcuda` is a link dependency.
- **Zero-copy device input is first-class.** `Encode()` ingests any
  `__cuda_array_interface__` / DLPack tensor and registers the device pointer with
  NVENC — exactly the zero-copy NV12→NVENC thing we built on PyAV, but native.
- **Full NVENC control surface**: tuning (incl. low-latency / ultra-low-latency),
  GOP/IDR length, B-frames, RC modes, VBV, multipass, lookahead, AQ, SEI insertion,
  and live **`Reconfigure()`** (change bitrate/RC without rebuilding the encoder).
  NVENC's native output is **Annex B** — our browser invariant holds for free.
- It builds two ABI variants (`_121`, `_130`) for NVENC SDK 12.1 / 13.0 and selects
  at runtime by driver version — its answer to the SDK-version churn we hit.

## Could it work on 3.14? — yes, with three things

1. **pybind11 bump** — the one hard blocker. 2.10.0 (Oct 2022) can't compile against
   CPython 3.14; **3.0.4** does, with no source changes to NVIDIA's code.
2. **No upstream wheel/sdist for 3.14** — we build from the vendored source.
3. **Heavyweight build** — scikit-build-core + CMake + **CUDA toolkit (nvcc)** for
   the `.cu` kernels (the *encode-only* subset needs none of them, which is what
   makes the spike light). Contrast the PyAV path: only ffmpeg dev headers + the
   driver, no toolkit.

## Spike results

`packages/nvenc/` is a thin pybind11 binding over NVIDIA's **verbatim**
`NvEncoderCuda` (under `third_party/`, MIT, unmodified — see `PROVENANCE.md`), with
all our code + NVTX instrumentation in `src/cpp/nvenc_ext.cpp`. Measured on this box
(RTX 4090 Laptop, driver R580, Ubuntu 24.04, CUDA 12.5/13.0):

| Check | Result |
| ----- | ------ |
| Build on CPython **3.14.6** (pybind11 3.0.4) | ✅ compiles clean (gcc/clang 18, C++17) |
| Encode GPU-resident NV12 from a **CuPy** CAI tensor, no host copy | ✅ 60 frames @1080p |
| Output is valid **H.264 Annex B** (in-band SPS/PPS) | ✅ start code `00 00 00 01 67`, decoded back by PyAV |
| **No PyAV** in the encode path | ✅ (PyAV used only to *verify* the bitstream) |
| Self-contained **wheel** (`auditwheel`, excl. driver libs) | ✅ `habemus_papadum_nvenc-…-cp314-…manylinux…whl`, ~223 KB (both ABIs) |
| **Dual NVENC ABI** (12.1 + 13.0) selected by driver at import | ✅ loads `_nvenc_130` on R580; `_nvenc_121` Annex B decodes too |
| Wheel in a **clean venv** (`env -i`, no `LD_LIBRARY_PATH`/system ffmpeg) | ✅ imports + encodes; needs only the host driver |
| **NVTX** profiling build (`USE_NVTX=ON`) | ✅ compiles; ranges active |

The input path uses `GetNextInputFrame` + `CopyToDeviceFrame` — one **intra-GPU**
NV12 copy (no host round-trip). True zero-copy via `NvEncoder::RegisterResource` is a
follow-up; the copy is negligible next to the CPU path's reformat+upload.

### NVTX ranges

A profiling build (`./build-wheel.sh --nvtx` or `-DUSE_NVTX=ON`) emits our
binding-boundary ranges and activates NVIDIA's internal ones, nesting as:

```
pdum.encode
├── pdum.read_cai          (read __cuda_array_interface__)
├── pdum.copy_to_nvenc     → CopyToDeviceFrame_aligned/unaligned   (NVIDIA)
├── pdum.submit            → EncodeFrame → DoEncode, MapResources   (NVIDIA)
└── pdum.collect_output    (concat Annex B bytes)
```

Profile with `nsys profile -t nvtx,cuda python your_script.py`. NVTX3 is
header-only and ~free when no profiler is attached.

## Verdict

**Stay on PyAV; keep this as a documented escape hatch.** Reach for the SDK backend if
either: PyAV 18 stays unreleased much longer, or we hit a wall the ffmpeg wrapper
makes awkward — most likely **live `Reconfigure()`** for adaptive bitrate (pairs with
`AdaptiveQualityController`), SEI insertion, or finer RC/multipass control. The
deciding factor is PyAV 18's release timing: once it ships, our path is a one-line
install and the SDK's main advantage (no PyAV) evaporates.

## Integration plan

It slots into the existing encoder seam; the architecture already anticipated this.
**All steps are done.**

1. ✅ **Promoted** to the maintained encode-only package `packages/nvenc/`
   (`habemus-papadum-nvenc`, `import pdum.nvenc`) — the `third_party/` verbatim subset
   + our binding, built into a self-contained wheel (`build-wheel.sh`) and **published
   to PyPI** by `scripts/publish.sh`. Ships both NVENC **12.1 + 13.0** ABIs, selected
   by the driver at import. True zero-copy via `RegisterResource` is still a follow-up.
2. ✅ **New backend** `encoders/nvenc_gpu_pdum.py` (`NvencGpuPdumEncoder`, registered
   `"nvenc_gpu_pdum"`) implements the `EncoderBackend` protocol: fixed-resolution (resize
   rebuilds + keyframes via the session's `encoder_factory`), real timestamps,
   `force_keyframe → NV_ENC_PIC_FLAG_FORCEIDR`, in-band SPS/PPS, no B-frames. It feeds
   the encoder our on-GPU `gpu.rgb_to_nv12` output (CUDA `nv12` frames pass straight
   through). **Zero-latency** is essential here: NvEncoder's default `nExtraOutputDelay=3`
   delays output by 3 frames (~100 ms) *and* makes a single `encode()` return a *later*
   frame's AU — wrong seq attribution. The binding exposes `extra_output_delay` and the
   backend sets it to **0** (synchronous 1-in-1-out), so each AU returns from its own
   `encode()` call.
3. ✅ **Availability probe** `nvenc_gpu_pdum_available()` (CuPy + `pdum.nvenc`
   importable + a real two-frame encode, no decode so it stays PyAV-free; cached).
   `serve(gpu=True)` **prefers** the SDK backend when present, else `nvenc_gpu_pyav` (PyAV≥18).
4. ✅ **Context sharing reused as-is**: the binding takes `cuda_context=0` → retains the
   device **primary** context (the one CuPy uses), so device pointers are valid to NVENC
   with no cross-context copy. NVTX ranges are compiled in by default (header-only).
5. ✅ **Extra**: `habemus-papadum-rfb[gpu-nvenc-sdk]` pulls `habemus-papadum-nvenc`
   (the SDK wheel) **+ CuPy** straight from PyPI — a normal dependency, since the SDK
   source is MIT and the wheel is clean to publish (unlike the LGPL PyAV-18 wheel).

## Licensing

PyNvVideoCodec and the SDK headers are **MIT** (per-file headers preserved in
`third_party/`); our binding/build code is MIT. A built wheel carries MIT
obligations only and bundles **no** `libcuda`/`libnvidia-encode` — those are host
driver components. To refresh against a newer SDK, re-copy the files listed in
`packages/nvenc/PROVENANCE.md`.
