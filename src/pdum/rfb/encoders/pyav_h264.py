"""CPU H.264 encoder via PyAV / libx264 (guide section 6).

Produces **Annex B** access units (in-band SPS/PPS on key frames) suitable for
the browser's WebCodecs ``VideoDecoder`` in Annex B mode. Configured for low
latency: ``ultrafast``/``zerolatency``, no B-frames, periodic IDR.

Several gaps in the guide's sketch are fixed here:

* forced keyframes are real IDRs (``forced-idr=1`` + per-frame ``pict_type=I``);
* RGB is explicitly reformatted to ``yuv420p`` (PyAV does not auto-convert);
* ``annexb=1`` / ``repeat-headers=1`` keep parameter sets in-band.

PyAV is imported lazily so this module can be imported (e.g. for
:func:`h264_available`) even where ``av`` is installed only as the optional
``h264`` extra.
"""

from __future__ import annotations

import importlib.util
from fractions import Fraction

import numpy as np

from ..protocol import DEFAULT_H264_CODEC
from ..types import EncodedPayload, RawFrame


def h264_available() -> bool:
    """True if PyAV is importable."""
    return importlib.util.find_spec("av") is not None


def libx264_available() -> bool:
    """True if PyAV is importable and exposes the libx264 encoder."""
    if not h264_available():
        return False
    try:
        import av

        return "libx264" in av.codecs_available
    except Exception:  # pragma: no cover - defensive
        return False


class PyAvH264Encoder:
    """Encode CPU ``rgb24`` frames to H.264 Annex B access units."""

    def __init__(
        self,
        *,
        width: int,
        height: int,
        fps: int = 30,
        bitrate: int = 12_000_000,
        codec_string: str | None = None,
    ) -> None:
        import av

        self.width = width
        self.height = height
        self.fps = fps
        self.bitrate = bitrate
        self.codec_string = codec_string or DEFAULT_H264_CODEC
        self.frame_index = 0
        self._duration_us = int(1_000_000 / fps)

        self.ctx = av.CodecContext.create("libx264", "w")
        self.ctx.width = width
        self.ctx.height = height
        self.ctx.pix_fmt = "yuv420p"
        self.ctx.time_base = Fraction(1, fps)
        self.ctx.framerate = Fraction(fps, 1)
        self.ctx.bit_rate = bitrate
        # Low latency: ultrafast, zerolatency, no B-frames, periodic in-band IDR.
        self.ctx.options = {
            "preset": "ultrafast",
            "tune": "zerolatency",
            "profile": "baseline",
            "forced-idr": "1",
            "x264-params": (f"keyint={fps}:min-keyint={fps}:scenecut=0:bframes=0:annexb=1:repeat-headers=1"),
        }

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        import av

        if frame.memory != "cpu" or frame.pixel_format != "rgb24":
            raise TypeError("PyAvH264Encoder expects CPU rgb24 frames")
        arr = frame.data
        if not isinstance(arr, np.ndarray):
            raise TypeError("Expected numpy.ndarray")

        vf = av.VideoFrame.from_ndarray(np.ascontiguousarray(arr), format="rgb24")
        vf = vf.reformat(format="yuv420p")
        vf.pts = self.frame_index
        vf.time_base = Fraction(1, self.fps)
        if force_keyframe:
            vf.pict_type = av.video.frame.PictureType.I
        self.frame_index += 1

        return [self._payload(frame.seq, frame.timestamp_us, pkt) for pkt in self._drain(vf)]

    def flush(self) -> list[EncodedPayload]:
        return [self._payload(-1, 0, pkt) for pkt in self._drain(None)]

    def close(self) -> None:
        try:
            self.flush()
        except Exception:  # pragma: no cover - encoder may already be closed
            pass

    # --- helpers ------------------------------------------------------------

    def _drain(self, vf):
        for packet in self.ctx.encode(vf):
            data = bytes(packet)
            if data:
                yield packet, data

    def _payload(self, seq: int, timestamp_us: int, pkt) -> EncodedPayload:
        packet, data = pkt
        return EncodedPayload(
            seq=seq,
            kind="video",
            timestamp_us=timestamp_us,
            width=self.width,
            height=self.height,
            payload=data,
            codec=self.codec_string,
            keyframe=bool(packet.is_keyframe),
            duration_us=self._duration_us,
            metadata={"bitstream": "annexb", "encoder": "pyav-libx264"},
        )


def self_test(width: int = 64, height: int = 64, frames: int = 8) -> bool:
    """Encode a few synthetic frames and decode them back to prove validity.

    Returns ``True`` if the produced Annex B bitstream decodes to a plausible
    number of frames at the expected resolution. Doubles as a runtime check
    that libx264 is actually usable.
    """
    if not libx264_available():
        return False

    from ..testing import decode_annexb

    enc = PyAvH264Encoder(width=width, height=height, fps=int(frames))
    chunks: list[bytes] = []
    for seq in range(frames):
        arr = np.full((height, width, 3), (seq * 7) % 256, dtype=np.uint8)
        arr[:, : width // 2] = ((seq * 11) % 256, (seq * 5) % 256, 64)
        for payload in enc.encode(
            RawFrame(seq, width, height, seq * 1000, "rgb24", "cpu", arr),
            force_keyframe=(seq == 0),
        ):
            chunks.append(payload.payload)
    for payload in enc.flush():
        chunks.append(payload.payload)
    enc.close()

    decoded = decode_annexb(b"".join(chunks))
    if not decoded:
        return False
    return all(f.width == width and f.height == height for f in decoded)
