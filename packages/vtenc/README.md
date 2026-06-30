# habemus-papadum-vtenc (`import pdum.vtenc`)

macOS **host NV12 → H.264 Annex B** via Apple's **VideoToolbox** (`VTCompressionSession`),
with **no PyAV and no ffmpeg**. The companion encoder for
[`pdum.rfb`](../../README.md) (PyPI: `habemus-papadum-rfb`) on Apple Silicon — the
counterpart of [`habemus-papadum-nvenc`](../nvenc/README.md) on NVIDIA. A uv workspace
member of this repo. Design notes:
[`docs/mlx_metal_videotoolbox_encoder_design.md`](../../docs/mlx_metal_videotoolbox_encoder_design.md).

Why it exists:

1. **Hardware H.264 on macOS without PyAV.** VideoToolbox is the Apple-Silicon hardware
   encoder; this binds it directly, so the GPU path needs no ffmpeg layer.
2. **MLX-friendly.** Its `encode()` takes any Python buffer-protocol object, so an
   evaluated MLX `mx.array` (Apple-Silicon unified memory) feeds it directly.

## What's ours

Everything is ours — there is **no vendored SDK** (VideoToolbox/CoreVideo/CoreMedia are
macOS system frameworks):

```
src/cpp/vtenc_ext.mm        OURS — the only native code; a thin pybind11 binding over
                            VTCompressionSession (Objective-C++).
src/pdum/vtenc/__init__.py  OURS — Python surface + single-extension loader.
CMakeLists.txt              OURS — pybind11 3.0.4; -framework links; one _vtenc module.
build-wheel.sh              OURS — self-contained wheel build (delocate).
```

## Behaviour (matches the pdum.rfb invariants)

- **NV12 in → H.264 Annex B out** (start codes, in-band SPS/PPS on every IDR — what the
  browser's WebCodecs `VideoDecoder` wants).
- **Low-latency, no frame reordering** (no B-frames ⇒ output order == input order) and
  **synchronous 1-in-1-out**: each `encode()` returns *its own* frame's access unit
  (`CompleteFrames` after each submit) — required for correct seq attribution.
- **BT.601 limited range** VUI (matches `pdum.rfb`'s `gpu.rgb_to_nv12` kernel), so a
  browser decodes the color correctly.
- Fixed-resolution, even dimensions; one `VTCompressionSession` per instance.

## Usage

```python
import numpy as np
from pdum.vtenc import VtEncoder

enc = VtEncoder(1920, 1080, fps=30, bitrate=12_000_000)
nv12 = np.zeros((1080 * 3 // 2, 1920), dtype=np.uint8)   # contiguous NV12 (Y then UV)
# ... fill nv12 (e.g. from an evaluated MLX array) ...
annexb = enc.encode(nv12, force_idr=True)                # bytes; H.264 Annex B
annexb += enc.flush()
print(enc.codec_string)                                  # e.g. "avc1.420028" (from the SPS)
enc.close()
```

`encode()` accepts any contiguous `(H*3//2, W)` `uint8` buffer-protocol object — numpy or
an **evaluated** MLX `mx.array` (call `mx.eval(frame)` first; MLX is lazy).

`VtEncoder.codec_string` is the `avc1.PPCCLL` string derived from the **actual** emitted
SPS (VideoToolbox picks the level from the resolution, so it is not a constant — 1080p
Baseline is `avc1.420028`, not `avc1.42E01F`). Empty until the first keyframe.

## Build & test (local, CMake)

```bash
cmake -S . -B build -G Ninja
cmake --build build -j
```

## Build wheels (maintainer)

```bash
./build-wheel.sh                                 # cp314 -> dist/habemus_papadum_vtenc-*.whl
PYTHON_VERSIONS="3.12 3.13 3.14" ./build-wheel.sh
```

Requires only **Xcode Command Line Tools** (clang + the macOS SDK frameworks); the full
Metal toolchain is not needed for v1. The wheel bundles nothing beyond the extension —
the frameworks come from macOS, as they must. **Publishing to PyPI is done by
[`scripts/publish.sh`](../../scripts/publish.sh)**, not from CI.

## Scope / caveats

- Fixed-resolution NV12 in, Annex B out, one encoder per instance. H.264 only (HEVC is a
  follow-up). No `EncoderBackend`/`serve()` wiring yet — that's the `pdum.rfb` integration.
- Input is a **host-visible** (CPU / unified-memory) NV12 buffer, memcpy'd into an
  encoder-owned `CVPixelBuffer`. Wrapping an MLX unified-memory buffer as the
  `CVPixelBuffer` backing directly (true zero-copy) is a follow-up.
