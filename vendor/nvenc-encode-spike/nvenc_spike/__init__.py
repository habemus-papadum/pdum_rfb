"""pdum.rfb encode-only NVENC spike.

A thin Python package over NVIDIA's Video Codec SDK encoder (NvEncoderCuda),
proving GPU-resident NV12 -> H.264/HEVC Annex B encoding with no host copy, and
with no PyAV dependency, on Python 3.14. See docs/nvenc_sdk_evaluation.md.

Runtime requirements (not bundled in the wheel): an NVIDIA driver providing
``libcuda.so.1`` + ``libnvidia-encode.so.1`` and an NVENC-capable GPU. Any
``__cuda_array_interface__`` producer (CuPy / PyTorch / Numba) can supply frames.
"""

from ._nvenc_spike import NvencSpike, nvtx_enabled

__all__ = ["NvencSpike", "nvtx_enabled"]
__version__ = "0.0.1"
