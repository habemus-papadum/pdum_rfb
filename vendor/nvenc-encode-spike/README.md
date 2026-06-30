# nvenc-encode-spike

An **encode-only** spike over NVIDIA's Video Codec SDK encoder, evaluating it as a
future alternative to the PyAV `h264_nvenc` path for `pdum.rfb`. It answers two
questions cheaply (see [`docs/nvenc_sdk_evaluation.md`](../../docs/nvenc_sdk_evaluation.md)
for the full assessment):

1. **Does NVIDIA's SDK encoder build + run on CPython 3.14?** Upstream
   `PyNvVideoCodec` pins **pybind11 2.10.0**, which can't build on 3.14, and ships
   no cp314 wheel/sdist. This spike bumps pybind11 to **v3.0.4** and builds clean.
2. **GPU NV12 → H.264/HEVC Annex B with no host copy and no PyAV?** Yes — it
   encodes any `__cuda_array_interface__` tensor (CuPy / PyTorch / Numba) directly,
   sidestepping the PyAV-18 requirement entirely.

## What's ours vs NVIDIA's

```
src/nvenc_spike.cpp     OURS — the only hand-written C++; thin pybind11 binding +
                        all NVTX ranges. Wraps NvEncoderCuda; no NVIDIA edits.
nvenc_spike/__init__.py OURS — Python package surface.
CMakeLists.txt          OURS — pybind11 3.0.4 (the 3.14 fix) + optional NVTX.
build-wheel.sh          OURS — self-contained wheel build (auditwheel).
third_party/            VERBATIM, UNMODIFIED NVIDIA SDK (MIT). See PROVENANCE.md.
```

The NVIDIA source under `third_party/` is copied byte-for-byte from
`PyNvVideoCodec 2.1.0` with its MIT headers intact; we made **zero** edits to it.

## Build & test (local, CMake)

```bash
cmake -S . -B build -G Ninja -DUSE_NVTX=OFF      # or -DUSE_NVTX=ON for profiling
cmake --build build -j
# smoke test (needs cupy + av in the env):
PYTHONPATH=build python -c "import _nvenc_spike; print(_nvenc_spike.NvencSpike)"
```

## Build a hostable wheel (maintainer)

```bash
./build-wheel.sh                 # cp314 -> dist/pdum_rfb_nvenc_sdk-*.whl
./build-wheel.sh --nvtx          # profiling wheel (NVTX ranges on)
PYTHON_VERSIONS="3.12 3.13 3.14" ./build-wheel.sh
```

The wheel bundles its C/C++ runtime deps but **not** `libcuda` / `libnvidia-encode`
— those come from the host NVIDIA driver, as they must.

## Usage

```python
import cupy as cp
from nvenc_spike import NvencSpike

enc = NvencSpike(1920, 1080, codec="h264", preset="p3", tuning="ll", fps=30, gop=30)
nv12 = cp.empty((1080 * 3 // 2, 1920), dtype=cp.uint8)   # contiguous NV12
# ... render into nv12 ...
annexb = enc.encode(nv12, force_idr=True)                # bytes; H.264 Annex B
annexb += enc.flush()
enc.close()
```

`NvencSpike(cuda_context=0)` retains the device **primary** context — the same one
CuPy/PyTorch use — so device pointers are valid to NVENC with no cross-context copy.

## NVTX profiling

Built with `--nvtx` / `-DUSE_NVTX=ON`, the binding emits ranges at the Python
boundary (`pdum.encode`, `pdum.read_cai`, `pdum.copy_to_nvenc`, `pdum.submit`,
`pdum.collect_output`) and activates NVIDIA's internal ranges (`EncodeFrame`,
`DoEncode`, `MapResources`, `CopyToDeviceFrame_*`). Profile with Nsight Systems:
`nsys profile -t nvtx,cuda python your_script.py`.

## Scope / caveats

- **Spike, not product.** Fixed-resolution NV12 in, Annex B out, one encoder per
  instance. No reconfigure/SEI/EncoderBackend wiring yet — that's the integration.
- Input uses `GetNextInputFrame` + `CopyToDeviceFrame` (one **intra-GPU** copy, no
  host round-trip). True zero-copy via `NvEncoder::RegisterResource` is a follow-up.
- Builds the NVENC **12.1** ABI by default (widest driver compatibility).
