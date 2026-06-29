"""Remote Frame Buffer.

A transport-neutral remote framebuffer: Python produces frames, encodes them
(image or CPU H.264), streams them over WebSocket, and a browser decodes them to
a canvas while sending pointer/key/resize events back.

The PyAV-dependent H.264 symbols (``PyAvH264Encoder``, ``h264_available``) are
loaded lazily via :pep:`562` so that base (image-only) installs without the
optional ``av`` dependency can still ``import pdum.rfb``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .adaptive import AdaptiveQualityController, QualityTarget
from .encoders import ImageEncoder, available_video_encoders, build_encoder, register_video_encoder
from .metrics import SessionMetrics
from .protocol import (
    BackendSelection,
    UnsupportedClient,
    pack_binary_message,
    select_transport,
    unpack_binary_message,
)
from .session import RfbSession
from .sources import BaseFrameSource, OnDemandFrameSource, RenderCallbackSource
from .types import EncodedPayload, EncoderBackend, FrameSource, RawFrame

__version__ = "0.1.0-alpha"

__all__ = [
    "__version__",
    "AdaptiveQualityController",
    "BackendSelection",
    "BaseFrameSource",
    "EncodedPayload",
    "EncoderBackend",
    "FrameSource",
    "ImageEncoder",
    "OnDemandFrameSource",
    "PyAvH264Encoder",  # lazy
    "QualityTarget",
    "RawFrame",
    "RenderCallbackSource",
    "RfbServer",
    "RfbSession",
    "SessionMetrics",
    "UnsupportedClient",
    "available_video_encoders",
    "build_encoder",
    "h264_available",  # lazy
    "pack_binary_message",
    "register_video_encoder",
    "select_transport",
    "serve",
    "unpack_binary_message",
]

if TYPE_CHECKING:  # pragma: no cover
    from .encoders.pyav_h264 import PyAvH264Encoder, h264_available
    from .server import RfbServer, serve


def __getattr__(name: str):
    """Lazily import optional / submodule-executing symbols (PEP 562).

    ``server`` is imported lazily so ``python -m pdum.rfb.server`` does not warn
    about double execution; the H.264 symbols are lazy so base installs without
    the optional ``av`` dependency can still ``import pdum.rfb``.
    """
    if name in ("PyAvH264Encoder", "h264_available"):
        from .encoders import pyav_h264

        return getattr(pyav_h264, name)
    if name in ("RfbServer", "serve"):
        from . import server

        return getattr(server, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
