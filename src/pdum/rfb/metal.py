"""Apple Metal / MLX GPU frame helpers — the unified-memory analog of :mod:`pdum.rfb.gpu`.

Where :mod:`pdum.rfb.gpu` lets a **CUDA** tensor be encoded by NVENC without a host round-trip,
this module lets an **MLX** (Apple Metal, unified-memory) frame be converted **RGB(A) → NV12 on
the GPU** with a custom ``mx.fast.metal_kernel`` and handed to the VideoToolbox encoder — instead
of the CPU color-conversion pass (~6.6 ms at 1080p, and it pegs a core). On Apple Silicon there is
no PCIe upload to eliminate, so the remaining copy (host NV12 → ``CVPixelBuffer``) is negligible
(≤2 % of frame time, measured); the win here is moving the *color conversion* onto the GPU.

Everything lazy-imports ``mlx`` so ``import pdum.rfb`` never requires it. macOS + MLX only; gate on
:func:`mlx_available`. The natural producer is a render kernel that writes an ``(H, W, 4)`` RGBA
``mx.array`` (see ``examples/mlx_vt_stream.py``); publish it directly (``display.publish(rgba)`` —
an MLX array is recognized as a ``memory="metal"`` frame) or wrap a pre-converted NV12 array with
:func:`metal_frame`.
"""

from __future__ import annotations

import functools
import importlib.util
import sys
from typing import Any

from .types import RawFrame

#: DLPack ``DLDeviceType.kDLMetal`` — what an MLX GPU array reports from ``__dlpack_device__()``.
DL_METAL = 8


@functools.lru_cache(maxsize=1)
def mlx_available() -> bool:
    """True if MLX (Apple Metal) is usable in this process (cached). macOS + ``mlx`` importable."""
    if sys.platform != "darwin" or importlib.util.find_spec("mlx") is None:
        return False
    try:
        import mlx.core as mx

        return "gpu" in str(mx.default_device()).lower()
    except Exception:
        return False


@functools.lru_cache(maxsize=1)
def _nv12_kernel():
    """The RGB(A)→NV12 Metal kernel (built once). ``C`` (channels) is a template int so the same
    kernel handles ``rgb24`` (3) and ``rgba8`` (4). BT.601 limited range — byte-identical to
    :func:`pdum.rfb.gpu.rgb_to_nv12` and the CPU path, so a VideoToolbox stream and a CUDA/NVENC
    stream tag color the same way."""
    import mlx.core as mx

    return mx.fast.metal_kernel(
        name="pdum_rgb_to_nv12",
        input_names=["rgb"],
        output_names=["out"],
        source="""
            uint x = thread_position_in_grid.x;
            uint y = thread_position_in_grid.y;
            if (x >= W || y >= H) return;
            uint ri = (y * W + x) * C;
            float r = float(rgb[ri + 0]);
            float g = float(rgb[ri + 1]);
            float b = float(rgb[ri + 2]);
            out[y * W + x] = (uint8_t)clamp(0.257f * r + 0.504f * g + 0.098f * b + 16.0f, 0.0f, 255.0f);
            if ((x % 2u == 0u) && (y % 2u == 0u)) {
                float U = -0.148f * r - 0.291f * g + 0.439f * b + 128.0f;
                float V =  0.439f * r - 0.368f * g - 0.071f * b + 128.0f;
                uint uv = W * H + (y / 2u) * W + (x / 2u) * 2u;  // contiguous NV12 UV plane
                out[uv + 0] = (uint8_t)clamp(U, 0.0f, 255.0f);
                out[uv + 1] = (uint8_t)clamp(V, 0.0f, 255.0f);
            }
        """,
    )


def rgb_to_nv12(rgb: Any):
    """Convert a Metal ``rgb24``/``rgba8`` MLX array ``(H, W, 3|4)`` to a contiguous NV12 MLX
    array ``(H + H//2, W)`` on the GPU. Returns a **lazy** ``mx.array`` (call :func:`to_host_nv12`
    or ``mx.eval`` to materialize). Even dimensions required."""
    import mlx.core as mx

    if not isinstance(rgb, mx.array):
        rgb = mx.array(rgb)
    if rgb.ndim != 3 or rgb.shape[2] < 3:
        raise ValueError(f"rgb_to_nv12 expects (H, W, 3|4); got shape {tuple(rgb.shape)!r}")
    h, w, c = int(rgb.shape[0]), int(rgb.shape[1]), int(rgb.shape[2])
    if w % 2 or h % 2:
        raise ValueError(f"NV12 requires even dimensions; got {w}x{h}")
    (out,) = _nv12_kernel()(
        inputs=[rgb],
        template=[("W", w), ("H", h), ("C", c)],
        grid=(w, h, 1),
        threadgroup=(16, 16, 1),
        output_shapes=[(h + h // 2, w)],
        output_dtypes=[mx.uint8],
    )
    return out


def materialize(array: Any) -> None:
    """Force a lazy MLX array to compute **on the calling thread**. MLX binds a lazy graph's
    nodes to the thread's default stream, so an array built on the publish/loop thread cannot be
    evaluated on the session's encode *worker* thread ("no Stream(gpu, 0) in current thread").
    :meth:`Display.publish` calls this for Metal frames so the render is materialized on the loop
    thread; the (cheap) NV12 conversion then runs safely on the worker thread over the eager buffer."""
    import mlx.core as mx

    mx.eval(array)


def to_host_nv12(array: Any):
    """Evaluate a Metal NV12 MLX array and return a contiguous host ``numpy`` view. Unified memory
    makes ``np.asarray`` a near-zero-copy handoff; the VideoToolbox binding then does the small
    ``CVPixelBuffer`` copy."""
    import mlx.core as mx
    import numpy as np

    mx.eval(array)
    return np.ascontiguousarray(np.asarray(array))


def metal_frame(
    array: Any,
    *,
    pixel_format: str = "auto",
    width: int | None = None,
    height: int | None = None,
    seq: int = 0,
    timestamp_us: int = 0,
) -> RawFrame:
    """Wrap an MLX (Metal) array as a ``memory="metal"`` :class:`~pdum.rfb.types.RawFrame` for
    ``publish()`` — the Metal analog of :func:`pdum.rfb.gpu.cuda_frame`.

    ``pixel_format="auto"`` infers from shape: ``(H, W, 3)`` → ``rgb24``, ``(H, W, 4)`` → ``rgba8``,
    2-D ``(H+H//2, W)`` → ``nv12``. Use this for a **pre-converted NV12** array; a plain RGBA array
    can be handed straight to ``display.publish()`` (it is recognized as a Metal frame). The array
    is referenced, not copied; keep it alive (and evaluated) until it is encoded.
    """
    import mlx.core as mx

    if not isinstance(array, mx.array):
        array = mx.array(array)
    shape = tuple(int(s) for s in array.shape)
    if pixel_format == "auto":
        if len(shape) == 3 and shape[2] == 3:
            pixel_format = "rgb24"
        elif len(shape) == 3 and shape[2] == 4:
            pixel_format = "rgba8"
        elif len(shape) == 2:
            pixel_format = "nv12"
        else:
            raise ValueError(f"cannot infer pixel_format from shape {shape!r}")
    if pixel_format == "nv12":
        width = shape[1] if width is None else width
        height = (shape[0] * 2 // 3) if height is None else height
    else:
        height = shape[0] if height is None else height
        width = shape[1] if width is None else width
    return RawFrame(
        seq=seq,
        width=int(width),
        height=int(height),
        timestamp_us=int(timestamp_us),
        pixel_format=pixel_format,  # type: ignore[arg-type]
        memory="metal",
        data=array,
    )


def to_host_rgb(frame: RawFrame):
    """Download a Metal frame to a contiguous host ``numpy`` **rgb24** array — used by the image /
    CPU encoders so an image-only client still works under ``serve(gpu=True)`` on macOS. ``rgba8``
    drops alpha; ``nv12`` is converted back to RGB (BT.601 limited) on the host."""
    import mlx.core as mx
    import numpy as np

    arr = frame.data
    if frame.memory != "metal":  # already host
        h = np.asarray(arr)
        return np.ascontiguousarray(h[:, :, :3]) if getattr(h, "ndim", 0) == 3 and h.shape[2] == 4 else h
    mx.eval(arr)
    host = np.asarray(arr)
    if frame.pixel_format in ("rgb24", "rgba8"):
        return np.ascontiguousarray(host[:, :, :3]) if host.shape[2] == 4 else np.ascontiguousarray(host)
    if frame.pixel_format == "nv12":
        return _nv12_to_rgb_host(host, frame.width, frame.height)
    raise ValueError(f"cannot convert {frame.pixel_format!r} Metal frame to host rgb")


def _nv12_to_rgb_host(nv12, w: int, h: int):
    """BT.601 limited-range NV12 ``(H+H//2, W)`` → host ``rgb24``. The inverse of the encode-side
    conversion; only used for the image-transport fallback of a pre-converted NV12 Metal frame."""
    import numpy as np

    y = nv12[:h].astype(np.float32)
    uv = nv12[h:].reshape(h // 2, w // 2, 2)
    u = np.repeat(np.repeat(uv[..., 0], 2, 0), 2, 1).astype(np.float32) - 128.0
    v = np.repeat(np.repeat(uv[..., 1], 2, 0), 2, 1).astype(np.float32) - 128.0
    c = y - 16.0
    r = np.clip(1.164 * c + 1.596 * v, 0, 255)
    g = np.clip(1.164 * c - 0.392 * u - 0.813 * v, 0, 255)
    b = np.clip(1.164 * c + 2.017 * u, 0, 255)
    return np.ascontiguousarray(np.stack([r, g, b], axis=-1).astype(np.uint8))


def to_host_frame(frame: RawFrame) -> RawFrame:
    """Return ``frame`` with its data on the host: a Metal frame is downloaded to a host
    ``rgb24`` :class:`~pdum.rfb.types.RawFrame` (:func:`to_host_rgb`); any other frame is
    returned unchanged. Lets the CPU / image encoders accept a published MLX frame — the frame
    was materialized on the publish thread, so this cross-thread read is safe."""
    if frame.memory != "metal":
        return frame
    import dataclasses

    return dataclasses.replace(frame, data=to_host_rgb(frame), memory="cpu", pixel_format="rgb24")


class MetalHostFrameAdapter:
    """Wrap a host :class:`~pdum.rfb.types.EncoderBackend` so it tolerates Metal frames.

    The Metal analog of :class:`pdum.rfb.gpu.HostFrameAdapter`: when the publisher pushes MLX
    (Metal) frames under ``serve(gpu=True)`` on macOS, an image-transport viewer's encoder is
    wrapped in this adapter, which downloads each Metal frame to host ``rgb24``
    (:func:`to_host_rgb`) before delegating. Host frames pass through untouched.
    """

    __slots__ = ("_inner",)

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False):
        return self._inner.encode(self._to_host(frame), force_keyframe=force_keyframe)

    def encode_still(self, frame: RawFrame):
        return self._inner.encode_still(self._to_host(frame))

    @staticmethod
    def _to_host(frame: RawFrame) -> RawFrame:
        return to_host_frame(frame)

    def flush(self):
        return self._inner.flush()

    def close(self) -> None:
        self._inner.close()
