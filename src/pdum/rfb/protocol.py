"""Wire protocol: binary envelope, header builders, and capability negotiation.

The transport is transport-neutral JSON for control plus a simple binary
envelope for image/video payloads::

    uint32le header_byte_length
    utf8 JSON header
    raw payload bytes

These functions are pure (no I/O) so they are fully unit-testable and the wire
shape is defined in exactly one place, shared by the session and the tests. The
binary envelope must stay byte-for-byte compatible with the JavaScript
``unpackBinaryMessage`` in ``widgets/src/protocol.ts``.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Literal

from .types import EncodedPayload

# --- Capability identifiers (must match the JS ``probeCapabilities`` output) ---
CAP_JPEG = "image/jpeg"
CAP_PNG = "image/png"
CAP_WEBP = "image/webp"
CAP_H264_ANNEXB = "webcodecs/h264-annexb"

#: Default codec string advertised for the CPU H.264 path (constrained baseline).
DEFAULT_H264_CODEC = "avc1.42E01F"

ImageMode = Literal["jpeg", "png", "webp"]
_MIME_BY_MODE: dict[ImageMode, str] = {
    "jpeg": CAP_JPEG,
    "png": CAP_PNG,
    "webp": CAP_WEBP,
}
_MODE_BY_CAP: dict[str, ImageMode] = {v: k for k, v in _MIME_BY_MODE.items()}


class UnsupportedClient(Exception):
    """Raised when a client advertises no transport the server can satisfy."""


def pack_binary_message(header: dict, payload: bytes) -> bytes:
    """Pack a header dict and payload bytes into a single binary message.

    The header is encoded as compact UTF-8 JSON (no spaces) prefixed by its
    little-endian ``uint32`` byte length.
    """
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(header_bytes)) + header_bytes + bytes(payload)


def unpack_binary_message(buf: bytes | bytearray | memoryview) -> tuple[dict, bytes]:
    """Inverse of :func:`pack_binary_message`.

    Returns
    -------
    tuple[dict, bytes]
        The decoded JSON header and the raw payload bytes.
    """
    mv = memoryview(buf)
    if len(mv) < 4:
        raise ValueError("buffer too small to contain a header length prefix")
    (n,) = struct.unpack("<I", mv[:4])
    if len(mv) < 4 + n:
        raise ValueError(f"buffer truncated: need {4 + n} bytes, have {len(mv)}")
    header = json.loads(bytes(mv[4 : 4 + n]).decode("utf-8"))
    payload = bytes(mv[4 + n :])
    return header, payload


def image_header(p: EncodedPayload) -> dict:
    """Build the binary-envelope header for an image frame."""
    return {
        "type": "image_frame",
        "seq": p.seq,
        "timestamp_us": p.timestamp_us,
        "width": p.width,
        "height": p.height,
        "mime": p.mime,
    }


def video_header(p: EncodedPayload) -> dict:
    """Build the binary-envelope header for an encoded video access unit."""
    bitstream = "annexb"
    if p.metadata and "bitstream" in p.metadata:
        bitstream = p.metadata["bitstream"]
    header = {
        "type": "video_chunk",
        "seq": p.seq,
        "timestamp_us": p.timestamp_us,
        "width": p.width,
        "height": p.height,
        "codec": p.codec,
        "bitstream": bitstream,
        "keyframe": p.keyframe,
    }
    if p.duration_us is not None:
        header["duration_us"] = p.duration_us
    return header


def header_for(p: EncodedPayload) -> dict:
    """Return the appropriate binary-envelope header for ``p``."""
    return image_header(p) if p.kind == "image" else video_header(p)


# --- Control messages -------------------------------------------------------


def parse_control(text: str) -> dict:
    """Parse a JSON control message into a dict."""
    return json.loads(text)


def config_message(*, transport: str, width: int, height: int, codec: str | None = None) -> str:
    """Build the server ``config`` control message (sent right after ``hello``)."""
    msg: dict = {"type": "config", "transport": transport, "width": width, "height": height}
    if codec is not None:
        msg["codec"] = codec
    return json.dumps(msg, separators=(",", ":"))


def stats_message(*, server_queue: int, dropped: int) -> str:
    """Build a server ``stats`` control message."""
    return json.dumps(
        {"type": "stats", "server_queue": server_queue, "dropped": dropped},
        separators=(",", ":"),
    )


# --- Capability negotiation (guide section 12) ------------------------------


@dataclass(slots=True)
class BackendSelection:
    """The encoder/transport the server chose for a connection."""

    transport: Literal["image", "h264"]
    mime: str | None = None  # for the image transport
    codec: str | None = None  # for the h264 transport, e.g. "avc1.42E01F"
    image_mode: ImageMode | None = None


def select_transport(
    client_supported: list[str],
    *,
    has_h264: bool,
    has_nvenc: bool = False,
    prefer_video: bool = True,
    image_mode: ImageMode = "jpeg",
) -> BackendSelection:
    """Choose the best backend given client capabilities and server encoders.

    Policy (guide section 12): if the client supports WebCodecs/H.264, the
    server prefers video and at least one H.264 encoder is available, pick
    H.264 (NVENC is preferred over the CPU path when present). Otherwise fall
    back to the best mutually-supported image format. ``has_nvenc`` is accepted
    now so the NVENC backend can be slotted in later without touching callers.

    Raises
    ------
    UnsupportedClient
        If no mutually-supported transport exists.
    """
    supported = set(client_supported)

    if prefer_video and CAP_H264_ANNEXB in supported and (has_nvenc or has_h264):
        return BackendSelection(transport="h264", codec=DEFAULT_H264_CODEC)

    # Prefer the caller's requested image mode if the client supports it,
    # then fall back to any mutually-supported image format.
    preferred_cap = _MIME_BY_MODE[image_mode]
    ordered_caps = [preferred_cap, CAP_PNG, CAP_JPEG, CAP_WEBP]
    for cap in ordered_caps:
        if cap in supported:
            mode = _MODE_BY_CAP[cap]
            return BackendSelection(transport="image", mime=cap, image_mode=mode)

    raise UnsupportedClient(f"no supported transport in client capabilities: {sorted(supported)}")
