# Provenance of `third_party/`

Everything under `third_party/` is copied **verbatim and unmodified** from
**NVIDIA PyNvVideoCodec 2.1.0** (the source drop in `vendor/PyNvVideoCodec_2.1.0/`,
distributed by NVIDIA under the **MIT License**; each file retains its original
SPDX/copyright header). We made **zero** source edits — our only changes relative to
upstream are:

- a current **pybind11 (v3.0.4)** instead of upstream's pinned 2.10.0 (the fix that
  lets it build on Python 3.14), and
- our own binding/build files outside `third_party/` (`src/cpp/nvenc_ext.cpp`,
  `src/pdum/nvenc/`, `CMakeLists.txt`, `build-wheel.sh`).

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

Both ABIs are built: `NvEncoder_121.{h,cpp}` + `nvEncodeAPI_121.h` (`-DNVENC_VER_12_1`)
and `NvEncoder_130.{h,cpp}` + `nvEncodeAPI_130.h` (`-DNVENC_VER_13_0`); the loader picks
whichever the host driver supports.

## Licensing

The bundled NVIDIA SDK source is **MIT** (see file headers). Our code is **MIT**
(`src/`, `CMakeLists.txt`, etc.). A built wheel therefore carries MIT obligations
only; it does **not** bundle `libcuda`/`libnvidia-encode` (host driver components).
To refresh against a new SDK, re-copy the files above from the new source drop.
