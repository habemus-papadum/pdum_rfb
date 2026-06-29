"""Core data types and protocols for the remote framebuffer.

This module is intentionally dependency-free (no Pillow / PyAV / websockets) so
that ``import pdum.rfb.types`` is always cheap and safe, even in environments
that only need the type definitions.

The design follows three independent concerns (see the implementation guide):

``Frame source -> Encoder backend -> Transport backend``
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

MemoryKind = Literal["cpu", "cuda", "opengl"]
PixelFormat = Literal["rgb24", "rgba8", "bgra8", "nv12", "yuv420p"]
EncodedKind = Literal["image", "video"]

#: A normalized user-input event (see the common event vocabulary in the guide).
EventDict = dict[str, Any]


@dataclass(slots=True)
class RawFrame:
    """A single raw frame produced by a :class:`FrameSource`.

    Parameters
    ----------
    seq:
        Monotonically increasing frame sequence number.
    width, height:
        Frame dimensions in pixels.
    timestamp_us:
        Capture/render timestamp in microseconds.
    pixel_format:
        Layout of ``data`` (e.g. ``"rgb24"``, ``"rgba8"``, ``"nv12"``).
    memory:
        Where ``data`` lives (``"cpu"``, ``"cuda"`` or ``"opengl"``).
    data:
        The pixel payload. For CPU frames this is a ``numpy.ndarray`` of
        ``uint8``; for ``rgb24`` the shape is ``(H, W, 3)`` and for ``rgba8``
        it is ``(H, W, 4)``.
    """

    seq: int
    width: int
    height: int
    timestamp_us: int
    pixel_format: PixelFormat
    memory: MemoryKind
    data: Any


@dataclass(slots=True)
class EncodedPayload:
    """A single encoded payload ready to be put on the wire.

    One image is one payload (always a keyframe). One encoded video access unit
    is one payload; ``keyframe`` marks IDR access units.
    """

    seq: int
    kind: EncodedKind
    timestamp_us: int
    payload: bytes
    width: int
    height: int
    mime: str | None = None  # e.g. "image/jpeg", "image/png"
    codec: str | None = None  # e.g. "avc1.42E01F"
    keyframe: bool = False
    duration_us: int | None = None
    metadata: dict[str, Any] | None = None


@runtime_checkable
class FrameSource(Protocol):
    """Produces raw frames and consumes user-input events."""

    async def next_frame(self) -> RawFrame:
        """Return the next frame to encode (may block / pace to a target fps)."""
        ...

    async def handle_event(self, event: EventDict) -> None:
        """Handle a normalized user-input event from the client."""
        ...


@runtime_checkable
class EncoderBackend(Protocol):
    """Turns raw frames into encoded payloads."""

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        """Encode a single frame, returning zero or more payloads."""
        ...

    def flush(self) -> list[EncodedPayload]:
        """Drain any buffered payloads from the encoder."""
        ...

    def close(self) -> None:
        """Release encoder resources."""
        ...
