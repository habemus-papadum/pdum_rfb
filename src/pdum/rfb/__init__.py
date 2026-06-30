"""Remote Frame Buffer.

A transport-neutral remote framebuffer: Python produces frames, encodes them
(image or H.264), streams them over WebSocket, and a browser decodes them to a
canvas while sending pointer/key/resize events back.

The public API is push-based: start a server with :func:`serve`, then
``publish()`` frames to the returned :class:`Display` from your own loop and drain
input with :meth:`Display.poll_events`.

The PyAV-dependent H.264 symbols (``H264CpuEncoder``, ``NvencCpuEncoder``,
``h264_available``, ``nvenc_cpu_available``) are loaded lazily via :pep:`562` so base
(image-only) installs without the optional ``av`` dependency can still
``import pdum.rfb``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from . import gpu
from .adaptive import AdaptiveQualityController, QualityTarget
from .auth import AuthContext, Authenticator, Principal
from .display import Display
from .encoders import ImageEncoder, available_video_encoders, build_encoder, register_video_encoder
from .gpu import cuda_frame, cuda_zerocopy_available, enable_cuda_context_sharing
from .metrics import SessionMetrics
from .protocol import (
    BackendSelection,
    UnsupportedClient,
    pack_binary_message,
    select_transport,
    unpack_binary_message,
)
from .session import RfbSession
from .transport import Channel, WebSocketTransport
from .types import EncodedPayload, EncoderBackend, InputEvent, RawFrame

__version__ = "0.1.0-alpha"

__all__ = [
    "__version__",
    "AdaptiveQualityController",
    "AuthContext",
    "Authenticator",
    "BackendSelection",
    "Channel",
    "NvencGpuPyavEncoder",  # lazy
    "Display",
    "EncodedPayload",
    "EncoderBackend",
    "ImageEncoder",
    "InputEvent",
    "NvencCpuEncoder",  # lazy
    "Principal",
    "H264CpuEncoder",  # lazy
    "QualityTarget",
    "RawFrame",
    "RfbSession",
    "SessionMetrics",
    "UnsupportedClient",
    "WebSocketTransport",
    "available_video_encoders",
    "build_encoder",
    "cuda_frame",
    "nvenc_gpu_pyav_available",  # lazy
    "cuda_zerocopy_available",
    "enable_cuda_context_sharing",
    "gpu",
    "h264_available",  # lazy
    "nvenc_cpu_available",  # lazy
    "pack_binary_message",
    "register_video_encoder",
    "select_transport",
    "serve",
    "unpack_binary_message",
]

if TYPE_CHECKING:  # pragma: no cover
    from .encoders.h264_cpu import H264CpuEncoder, h264_available
    from .encoders.nvenc_cpu import NvencCpuEncoder, nvenc_cpu_available
    from .encoders.nvenc_gpu_pyav import NvencGpuPyavEncoder, nvenc_gpu_pyav_available
    from .server import serve


def __getattr__(name: str):
    """Lazily import optional / submodule-executing symbols (PEP 562).

    ``server`` is imported lazily so ``python -m pdum.rfb.server`` does not warn
    about double execution; the H.264 symbols are lazy so base installs without
    the optional ``av`` dependency can still ``import pdum.rfb``.
    """
    if name in ("H264CpuEncoder", "h264_available"):
        from .encoders import h264_cpu

        return getattr(h264_cpu, name)
    if name in ("NvencCpuEncoder", "nvenc_cpu_available"):
        from .encoders import nvenc_cpu

        return getattr(nvenc_cpu, name)
    if name in ("NvencGpuPyavEncoder", "nvenc_gpu_pyav_available"):
        from .encoders import nvenc_gpu_pyav

        return getattr(nvenc_gpu_pyav, name)
    if name == "serve":
        from . import server

        return server.serve
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
