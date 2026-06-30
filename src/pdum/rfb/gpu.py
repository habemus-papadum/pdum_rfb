"""GPU zero-copy helpers for the NVENC CUDA path (DLPack in, no host copy).

This module lets a CUDA-resident frame (a CuPy / PyTorch / any ``__dlpack__`` or
``__cuda_array_interface__`` tensor) be encoded by NVENC **without a round-trip
through host memory** — the encoder reads the device buffer directly. It is the
zero-copy counterpart to :mod:`pdum.rfb.encoders.nvenc_cpu` (which uploads host
``rgb24`` and reformats to ``yuv420p`` on the CPU first).

Everything here lazy-imports CuPy, so ``import pdum.rfb.gpu`` is always safe; the
functions raise only when actually called without CuPy.

Requirements (see :func:`cuda_zerocopy_available`)
--------------------------------------------------
1. **CuPy** (``cupy-cuda13x`` / ``cupy-cuda12x``; cp314 wheels exist).
2. An **NVENC-capable GPU + driver** (same gate as the host NVENC backend).
3. **PyAV that can *encode* CUDA frames.** ``from_dlpack`` (frame *creation*)
   landed in PyAV 17.0, but feeding those frames to an encoder
   (``hw_frames_ctx`` adopted before ``avcodec_open2``) lands only in **PyAV
   18.0** (unreleased as of this writing; the fix is on ``main`` — issue #2199).
   On PyAV 17.x this raises *"hw_frames_ctx must be set when using GPU frames as
   input"*; there is **no pure-Python workaround** (PyAV exposes no handle to set
   ``avctx->hw_frames_ctx``), so a ``< 18`` install must build PyAV from source
   (``main`` or the small patch documented in ``docs/gpu_zerocopy.md``).

Two non-obvious gotchas this module handles for you
---------------------------------------------------
* **One shared CUDA context.** CuPy uses the device *primary* context; FFmpeg's
  CUDA hwcontext (``primary_ctx=True``) wants it created with
  ``CU_CTX_SCHED_BLOCKING_SYNC`` flags. If CuPy activates it first with the
  default (auto) flags, ``primary_ctx=True`` fails ("incompatible flags") and a
  separate (``primary_ctx=False``) context can't register CuPy's pointers
  ("resource register failed"). :func:`enable_cuda_context_sharing` pre-sets the
  flags — **call it before any CuPy/Torch CUDA work** (importing is fine; the
  first allocation/op is what activates the context).
* **NV12 must be one contiguous allocation** (Y plane then UV plane), because
  NVENC reads UV at ``base + pitch*height``. :func:`rgb_to_nv12` produces that
  layout; :func:`nv12_planes` slices it back into the two DLPack planes.
"""

from __future__ import annotations

import ctypes
import functools
import importlib.util
import sys
from typing import Any

from .types import RawFrame

#: ``CU_CTX_SCHED_*`` flag values (driver API).
_SCHED_FLAGS = {"auto": 0x00, "spin": 0x01, "yield": 0x02, "blocking_sync": 0x04}

#: FFmpeg's CUDA hwcontext creates/expects the primary context with this flag.
_FFMPEG_SCHED = "blocking_sync"


def _libcuda() -> ctypes.CDLL | None:
    """Load the CUDA *driver* library (``libcuda``/``nvcuda``), or ``None``."""
    names = ("nvcuda.dll",) if sys.platform == "win32" else ("libcuda.so.1", "libcuda.so")
    for name in names:
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


def enable_cuda_context_sharing(device_id: int = 0, *, sched: str = _FFMPEG_SCHED) -> bool:
    """Pre-set the device primary-context flags so CuPy and FFmpeg share one context.

    **Call this once, first thing in your program, before any CuPy/PyTorch CUDA
    op.** It sets the device's primary-context scheduling flags to what FFmpeg's
    CUDA hwcontext wants (``CU_CTX_SCHED_BLOCKING_SYNC``); CuPy then retains that
    same primary context, and the zero-copy encoder (``primary_ctx=True``) can
    register CuPy's device pointers.

    Returns ``True`` on success. Returns ``False`` (and changes nothing) if the
    CUDA driver can't be loaded. If the primary context is *already active* with
    different flags (e.g. CuPy already ran), the driver call may still succeed but
    the flags will not take effect until the context is reset — so order matters.

    Parameters
    ----------
    device_id:
        CUDA device ordinal.
    sched:
        One of ``"blocking_sync"`` (default, required for FFmpeg sharing),
        ``"spin"``, ``"yield"``, ``"auto"``.
    """
    cu = _libcuda()
    if cu is None:
        return False
    flag = _SCHED_FLAGS[sched]
    if cu.cuInit(0) != 0:
        return False
    dev = ctypes.c_int()
    if cu.cuDeviceGet(ctypes.byref(dev), device_id) != 0:
        return False
    return cu.cuDevicePrimaryCtxSetFlags(dev, flag) == 0


# --- RGB <-> NV12 CUDA kernels (BT.601 limited range) -----------------------

_RGB_TO_NV12_SRC = r"""
extern "C" __global__ void rgb_to_nv12(const unsigned char* rgb, unsigned char* out, int W, int H){
  int x  = blockIdx.x*blockDim.x + threadIdx.x;
  int yy = blockIdx.y*blockDim.y + threadIdx.y;
  if(x>=W || yy>=H) return;
  int i = (yy*W + x)*3;
  float R=rgb[i], G=rgb[i+1], B=rgb[i+2];
  out[yy*W + x] = (unsigned char)(0.257f*R + 0.504f*G + 0.098f*B + 16.5f);   // Y plane
  if(((x&1)==0) && ((yy&1)==0)){                                            // UV plane @ W*H
    int u = W*H + (yy>>1)*W + (x>>1)*2;
    out[u]   = (unsigned char)(-0.148f*R - 0.291f*G + 0.439f*B + 128.5f);   // Cb
    out[u+1] = (unsigned char)( 0.439f*R - 0.368f*G - 0.071f*B + 128.5f);   // Cr
  }
}
"""

_NV12_TO_RGB_SRC = r"""
extern "C" __global__ void nv12_to_rgb(const unsigned char* nv12, unsigned char* rgb, int W, int H){
  int x  = blockIdx.x*blockDim.x + threadIdx.x;
  int yy = blockIdx.y*blockDim.y + threadIdx.y;
  if(x>=W || yy>=H) return;
  float Y = nv12[yy*W + x];
  int u = W*H + (yy>>1)*W + (x>>1)*2;
  float Cb = nv12[u], Cr = nv12[u+1];
  float C = Y - 16.0f, D = Cb - 128.0f, E = Cr - 128.0f;
  int r = (int)(1.164f*C + 1.596f*E + 0.5f);
  int g = (int)(1.164f*C - 0.391f*D - 0.813f*E + 0.5f);
  int b = (int)(1.164f*C + 2.018f*D + 0.5f);
  int o = (yy*W + x)*3;
  rgb[o]   = (unsigned char)(r<0?0:(r>255?255:r));
  rgb[o+1] = (unsigned char)(g<0?0:(g>255?255:g));
  rgb[o+2] = (unsigned char)(b<0?0:(b>255?255:b));
}
"""


@functools.lru_cache(maxsize=1)
def _kernels():
    import cupy as cp

    block = (16, 16, 1)
    return (
        cp.RawKernel(_RGB_TO_NV12_SRC, "rgb_to_nv12"),
        cp.RawKernel(_NV12_TO_RGB_SRC, "nv12_to_rgb"),
        block,
    )


def _grid(w: int, h: int, block):
    return ((w + block[0] - 1) // block[0], (h + block[1] - 1) // block[1], 1)


def _as_cupy(array: Any):
    """Adopt any CuPy / ``__dlpack__`` / ``__cuda_array_interface__`` tensor.

    Zero-copy when the source is already a CuPy array or a CUDA DLPack tensor on
    the same device; a host array is uploaded.
    """
    import cupy as cp

    return cp.asarray(array)


def rgb_to_nv12(rgb: Any, *, out: Any | None = None):
    """Convert a device ``rgb24`` tensor ``(H, W, 3)`` to contiguous NV12.

    Returns a CuPy ``uint8`` array of shape ``(H + H//2, W)``: the Y plane
    (``H`` rows) immediately followed by the interleaved UV plane (``H//2``
    rows) — the single-allocation layout NVENC requires. Pass ``out`` to reuse a
    buffer across frames (the zero-copy encoder does this).
    """
    import cupy as cp

    rgb = _as_cupy(rgb)
    if rgb.ndim != 3 or rgb.shape[2] < 3:
        raise ValueError(f"rgb_to_nv12 expects (H, W, 3); got shape {rgb.shape!r}")
    h, w = int(rgb.shape[0]), int(rgb.shape[1])
    if w % 2 or h % 2:
        raise ValueError(f"NV12 requires even dimensions; got {w}x{h}")
    if rgb.shape[2] != 3 or not rgb.flags.c_contiguous:
        rgb = cp.ascontiguousarray(rgb[:, :, :3])
    if out is None:
        out = cp.empty((h + h // 2, w), cp.uint8)
    k_rgb2nv12, _, block = _kernels()
    k_rgb2nv12(_grid(w, h, block), block, (rgb, out, w, h))
    return out


def nv12_planes(packed: Any) -> tuple[Any, Any]:
    """Slice a contiguous NV12 ``(H + H//2, W)`` buffer into ``(Y, UV)`` planes.

    The two returned CuPy arrays are *views* into ``packed`` (no copy), suitable
    for ``av.VideoFrame.from_dlpack([y, uv], format="nv12", ...)``.
    """
    packed = _as_cupy(packed)
    rows = int(packed.shape[0])
    h = rows * 2 // 3
    if h + h // 2 != rows:
        raise ValueError(f"not an NV12 buffer: {rows} rows is not 3/2 of an even height")
    return packed[:h], packed[h:]


def nv12_height(packed: Any) -> int:
    """Image height encoded by a contiguous NV12 ``(H + H//2, W)`` buffer."""
    rows = int(_as_cupy(packed).shape[0])
    return rows * 2 // 3


def cuda_frame(
    array: Any,
    *,
    pixel_format: str = "auto",
    width: int | None = None,
    height: int | None = None,
    seq: int = 0,
    timestamp_us: int = 0,
) -> RawFrame:
    """Wrap a device tensor as a CUDA :class:`~pdum.rfb.types.RawFrame` for ``publish()``.

    ``pixel_format="auto"`` infers from shape: ``(H, W, 3)`` -> ``rgb24``,
    ``(H, W, 4)`` -> ``rgba8``, 2-D ``(H+H//2, W)`` -> ``nv12``. Pass an explicit
    ``pixel_format`` (and ``height`` for ambiguous NV12) to override. The tensor
    is referenced, not copied; keep it alive until the frame is encoded.
    """
    arr = _as_cupy(array)
    if pixel_format == "auto":
        if arr.ndim == 3 and arr.shape[2] == 3:
            pixel_format = "rgb24"
        elif arr.ndim == 3 and arr.shape[2] == 4:
            pixel_format = "rgba8"
        elif arr.ndim == 2:
            pixel_format = "nv12"
        else:
            raise ValueError(f"cannot infer pixel_format from shape {arr.shape!r}")
    if pixel_format == "nv12":
        width = int(arr.shape[1]) if width is None else width
        height = nv12_height(arr) if height is None else height
    else:
        height = int(arr.shape[0]) if height is None else height
        width = int(arr.shape[1]) if width is None else width
    return RawFrame(
        seq=seq,
        width=int(width),
        height=int(height),
        timestamp_us=int(timestamp_us),
        pixel_format=pixel_format,  # type: ignore[arg-type]
        memory="cuda",
        data=arr,
    )


def to_host_rgb(frame: RawFrame):
    """Download a CUDA frame to a contiguous host ``numpy`` **rgb24** array.

    Used by the image / CPU H.264 encoders so an image-only (or CPU-fallback)
    client still works when the publisher pushes CUDA frames. ``rgba8`` drops
    alpha; ``nv12`` is converted to ``rgb24`` on the GPU first. A host frame is
    returned (coerced to 3-channel) unchanged.
    """
    import numpy as np

    if frame.memory == "cpu":
        arr = frame.data
        return np.ascontiguousarray(arr[:, :, :3]) if getattr(arr, "ndim", 0) == 3 and arr.shape[2] == 4 else arr

    import cupy as cp

    arr = _as_cupy(frame.data)
    if frame.pixel_format in ("rgb24", "rgba8"):
        return cp.asnumpy(cp.ascontiguousarray(arr[:, :, :3]) if arr.shape[2] == 4 else arr)
    if frame.pixel_format == "nv12":
        w, h = frame.width, frame.height
        rgb = cp.empty((h, w, 3), cp.uint8)
        _, k_nv122rgb, block = _kernels()
        k_nv122rgb(_grid(w, h, block), block, (cp.ascontiguousarray(arr), rgb, w, h))
        return cp.asnumpy(rgb)
    raise ValueError(f"cannot convert {frame.pixel_format!r} CUDA frame to host rgb")


class HostFrameAdapter:
    """Wrap a host :class:`~pdum.rfb.types.EncoderBackend` so it tolerates CUDA frames.

    The image / CPU encoders expect host frames; when the publisher pushes CUDA
    frames (``serve(gpu=True)``), an image-transport viewer's encoder is wrapped in
    this adapter, which downloads each CUDA frame to host ``rgb24``
    (:func:`to_host_rgb`) before delegating. Host frames pass through untouched, so
    the wrapped encoder stays dependency-pure and the existing contract is intact.
    """

    __slots__ = ("_inner",)

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False):
        return self._inner.encode(self._to_host(frame), force_keyframe=force_keyframe)

    def encode_still(self, frame: RawFrame):
        """Download a CUDA frame to host, then delegate the still to the wrapped
        encoder (keeps "still after settle" working in ``serve(gpu=True)`` +
        image-transport viewers)."""
        return self._inner.encode_still(self._to_host(frame))

    @staticmethod
    def _to_host(frame: RawFrame) -> RawFrame:
        if frame.memory == "cpu":
            return frame
        import dataclasses

        return dataclasses.replace(frame, data=to_host_rgb(frame), memory="cpu", pixel_format="rgb24")

    def flush(self):
        return self._inner.flush()

    def close(self) -> None:
        self._inner.close()


# --- availability gate ------------------------------------------------------


def _selftest_zerocopy_encode(width: int = 256, height: int = 128) -> bool:
    """Actually run one zero-copy NVENC encode; ``True`` iff PyAV supports it.

    This is the real test for the PyAV 18 capability: on PyAV 17.x it raises at
    ``avcodec_open2`` ("hw_frames_ctx must be set"). Side effects are confined to
    a tiny encode on the GPU.
    """
    try:
        import av
        import cupy as cp

        enable_cuda_context_sharing()
        from av.video.frame import CudaContext  # noqa: PLC0415

        cctx = CudaContext(device_id=0, primary_ctx=True)
        nv12 = cp.zeros((height + height // 2, width), cp.uint8)
        y, uv = nv12[:height], nv12[height:]
        cp.cuda.runtime.deviceSynchronize()
        ctx = av.CodecContext.create("h264_nvenc", "w")
        ctx.width, ctx.height, ctx.pix_fmt = width, height, "cuda"
        from fractions import Fraction  # noqa: PLC0415

        ctx.time_base = Fraction(1, 30)
        ctx.framerate = Fraction(30, 1)
        ctx.bit_rate = 1_000_000
        ctx.options = {"preset": "p4", "tune": "ll", "rc": "vbr", "bf": "0", "delay": "0"}
        out = []
        for s in range(2):
            f = av.VideoFrame.from_dlpack(
                [y, uv], format="nv12", width=width, height=height, primary_ctx=True, cuda_context=cctx
            )
            f.pts = s
            f.time_base = Fraction(1, 30)
            out += [bytes(p) for p in ctx.encode(f)]
        out += [bytes(p) for p in ctx.encode(None)]
        return sum(len(p) for p in out) > 0
    except Exception:
        return False


@functools.lru_cache(maxsize=1)
def cuda_zerocopy_available() -> bool:
    """True if the zero-copy CUDA→NVENC path is usable in this process (cached).

    Checks, in order: CuPy importable; an NVENC-capable GPU/driver
    (:func:`pdum.rfb.encoders.nvenc_cpu.nvenc_cpu_available`); and that PyAV can actually
    encode a CUDA frame (PyAV ≥ 18 or a from-source build with the fix). The
    self-test opens an NVENC session, so it runs at most once per process.

    .. note::
       Call :func:`enable_cuda_context_sharing` **before any CuPy CUDA op** for a
       reliable result — if CuPy has already activated the primary context with
       the default flags, the shared-context probe (and the encoder) will fail.
    """
    if importlib.util.find_spec("cupy") is None:
        return False
    try:
        from .encoders.nvenc_cpu import nvenc_cpu_available

        if not nvenc_cpu_available():
            return False
    except Exception:
        return False
    return _selftest_zerocopy_encode()
