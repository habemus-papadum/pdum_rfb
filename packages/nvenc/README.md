# habemus-papadum-nvenc (`import pdum.nvenc`)

GPU **NV12 → H.264/HEVC Annex B** via NVIDIA's Video Codec SDK encoder, with **no
PyAV and no host copy**. The companion GPU encoder for
[`pdum.rfb`](../../README.md) (PyPI: `habemus-papadum-rfb`); a uv workspace member of
this repo. Full assessment: [`docs/nvenc_sdk_evaluation.md`](../../docs/nvenc_sdk_evaluation.md).

Why it exists:

1. **Builds + runs on CPython 3.14.** Upstream `PyNvVideoCodec` pins **pybind11
   2.10.0** (no 3.14) and ships no cp314 wheel/sdist; this package builds against
   pybind11 **v3.0.4**.
2. **GPU-resident, PyAV-free.** Encodes any `__cuda_array_interface__` tensor
   (CuPy / PyTorch / Numba) directly, sidestepping the PyAV-18 requirement entirely.

## What's ours vs NVIDIA's

```
src/cpp/nvenc_ext.cpp      OURS — the only hand-written C++; thin pybind11 binding +
                           all NVTX ranges. Wraps NvEncoderCuda; no NVIDIA edits.
src/pdum/nvenc/__init__.py OURS — Python surface + the ABI loader (picks 12.1/13.0).
CMakeLists.txt             OURS — pybind11 3.0.4 (the 3.14 fix), dual ABI, optional NVTX.
build-wheel.sh             OURS — self-contained wheel build (auditwheel).
third_party/               VERBATIM, UNMODIFIED NVIDIA SDK (MIT). See PROVENANCE.md.
```

The NVIDIA source under `third_party/` is copied byte-for-byte from `PyNvVideoCodec
2.1.0` with its MIT headers intact; we made **zero** edits to it.

## Dual NVENC ABI

The wheel ships two extensions built from the same source — `_nvenc_121` (NVENC SDK
12.1) and `_nvenc_130` (13.0) — and `pdum/nvenc/__init__.py` loads whichever the host
driver supports (newest first, via a cheap `NvEncodeAPIGetMaxSupportedVersion` probe),
so one wheel works across old and new drivers.

## Build & test (local, CMake)

```bash
cmake -S . -B build -G Ninja -DUSE_NVTX=OFF      # or -DUSE_NVTX=ON for profiling
cmake --build build -j
```

## Build wheels (maintainer)

```bash
./build-wheel.sh                 # cp314 -> dist/habemus_papadum_nvenc-*.whl
./build-wheel.sh --nvtx          # profiling wheel (NVTX ranges on)
PYTHON_VERSIONS="3.12 3.13 3.14" ./build-wheel.sh
```

The wheel bundles its C/C++ runtime deps but **not** `libcuda` / `libnvidia-encode`
— those come from the host NVIDIA driver, as they must. **Publishing to PyPI is done
by [`scripts/publish.sh`](../../scripts/publish.sh)** (which calls this), not from CI.

## Usage

```python
import cupy as cp
from pdum.nvenc import NvencEncoder

enc = NvencEncoder(1920, 1080, codec="h264", preset="p3", tuning="ll", fps=30, gop=30)
nv12 = cp.empty((1080 * 3 // 2, 1920), dtype=cp.uint8)   # contiguous NV12
# ... render into nv12 ...
annexb = enc.encode(nv12, force_idr=True)                # bytes; H.264 Annex B
annexb += enc.flush()
enc.close()
```

`NvencEncoder(cuda_context=0)` retains the device **primary** context — the same one
CuPy/PyTorch use — so device pointers are valid to NVENC with no cross-context copy.

`NvencEncoder(extra_output_delay=0)` (the default) is **zero-latency**: each frame's
access unit is returned by its own `encode()` call (synchronous 1-in-1-out), which is
what a low-latency stream wants. Raise it (NVIDIA's helper defaults to 3) to overlap
encode with rendering for throughput, at a matching cost in frames of latency.

## NVTX profiling

Built with `--nvtx` / `-DUSE_NVTX=ON`, the binding emits ranges at the Python
boundary (`pdum.encode`, `pdum.read_cai`, `pdum.copy_to_nvenc`, `pdum.submit`,
`pdum.collect_output`) and activates NVIDIA's internal ranges (`EncodeFrame`,
`DoEncode`, `MapResources`, `CopyToDeviceFrame_*`). Profile with Nsight Systems:
`nsys profile -t nvtx,cuda python your_script.py`.

## Scope / caveats

- Fixed-resolution NV12 in, Annex B out, one encoder per instance. No reconfigure /
  SEI / `EncoderBackend` wiring yet — that's the `pdum.rfb` integration.
- Input uses `GetNextInputFrame` + `CopyToDeviceFrame` (one **intra-GPU** copy, no
  host round-trip). True zero-copy via `NvEncoder::RegisterResource` is a follow-up.
