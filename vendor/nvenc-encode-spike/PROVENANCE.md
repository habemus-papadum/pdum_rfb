# Provenance of `third_party/`

Everything under `third_party/` is copied **verbatim and unmodified** from
**NVIDIA PyNvVideoCodec 2.1.0** (the source drop in `vendor/PyNvVideoCodec_2.1.0/`,
distributed by NVIDIA under the **MIT License**; each file retains its original
SPDX/copyright header). We made **zero** source edits — the spike's only changes
relative to upstream are:

- a current **pybind11 (v3.0.4)** instead of upstream's pinned 2.10.0 (the fix that
  lets it build on Python 3.14), and
- our own binding/build files outside `third_party/` (`src/`, `CMakeLists.txt`,
  `nvenc_spike/`, `build-wheel.sh`).

## File map (origin → here)

All paths below are under `vendor/PyNvVideoCodec_2.1.0/src/VideoCodecSDKUtils/`.

| Spike path | Upstream origin |
| ---------- | --------------- |
| `third_party/NvEncoder/NvEncoderCuda.{h,cpp}` | `helper_classes/NvCodec/NvEncoder/NvEncoderCuda.{h,cpp}` |
| `third_party/NvEncoder/NvEncoder_121.{h,cpp}` | `helper_classes/NvCodec/NvEncoder/NvEncoder_121.{h,cpp}` |
| `third_party/NvEncoder/NvEncoder_130.{h,cpp}` | `helper_classes/NvCodec/NvEncoder/NvEncoder_130.{h,cpp}` |
| `third_party/Utils/NvCodecUtils.h` | `helper_classes/Utils/NvCodecUtils.h` |
| `third_party/Utils/Logger.h` | `helper_classes/Utils/Logger.h` |
| `third_party/Interface/configNvEncVer.h` | `Interface/configNvEncVer.h` |
| `third_party/Interface/nvEncodeAPI_121.h` | `Interface/nvEncodeAPI_121.h` |
| `third_party/Interface/nvEncodeAPI_130.h` | `Interface/nvEncodeAPI_130.h` |

Only the encode-only subset is vendored — no decoder, demuxer, transcoder, ffmpeg,
samples, or CUDA `.cu` kernels (the encoder needs none of them).

`NvEncoder_130.{h,cpp}` and `nvEncodeAPI_130.h` are included for completeness (and a
possible `-DNVENC_VER_13_0` build); the default build compiles the **12.1** ABI.

## Licensing

The bundled NVIDIA SDK source is **MIT** (see file headers). Our code is **MIT**
(`src/`, `CMakeLists.txt`, etc.). A built wheel therefore carries MIT obligations
only; it does **not** bundle `libcuda`/`libnvidia-encode` (host driver components).
To refresh against a new SDK, re-copy the files above from the new source drop.
