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


def h264_cpu_available() -> bool:
    """True if PyAV is importable and exposes the libx264 encoder."""
    if not h264_available():
        return False
    try:
        import av

        return "libx264" in av.codecs_available
    except Exception:  # pragma: no cover - defensive
        return False


class H264CpuEncoder:
    """Encode CPU ``rgb24`` frames to H.264 Annex B access units."""

    #: Recorded in each payload's ``metadata["encoder"]`` so the wire/headers
    #: identify which backend produced the bitstream. Subclasses override it.
    encoder_label = "h264-cpu"

    def __init__(
        self,
        *,
        width: int,
        height: int,
        fps: int = 30,
        bitrate: int = 12_000_000,
        codec_string: str | None = None,
    ) -> None:
        self.width = width
        self.height = height
        self.fps = fps
        self.bitrate = bitrate
        self.codec_string = codec_string or DEFAULT_H264_CODEC
        self.frame_index = 0
        self._duration_us = int(1_000_000 / fps)
        self.ctx = self._make_context()

    def _make_context(self):
        """Build the libx264 :class:`av.CodecContext` (overridden by NVENC)."""
        import av

        ctx = av.CodecContext.create("libx264", "w")
        ctx.width = self.width
        ctx.height = self.height
        ctx.pix_fmt = "yuv420p"
        ctx.time_base = Fraction(1, self.fps)
        ctx.framerate = Fraction(self.fps, 1)
        ctx.bit_rate = self.bitrate
        # Low latency: ultrafast, zerolatency, no B-frames, periodic in-band IDR.
        ctx.options = {
            "preset": "ultrafast",
            "tune": "zerolatency",
            "profile": "baseline",
            "forced-idr": "1",
            "x264-params": (f"keyint={self.fps}:min-keyint={self.fps}:scenecut=0:bframes=0:annexb=1:repeat-headers=1"),
        }
        return ctx

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        import av

        if frame.memory == "metal":  # a published MLX frame: download to host rgb24
            from ..metal import to_host_frame

            frame = to_host_frame(frame)
        if frame.memory != "cpu" or frame.pixel_format != "rgb24":
            raise TypeError("H264CpuEncoder expects CPU rgb24 frames")
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

    def encode_still(self, frame: RawFrame) -> list[EncodedPayload]:
        """A settled-scene still for the video path: a forced **IDR** of the frame.

        True lossless H.264 isn't practical over WebCodecs, so the still here is a
        clean, self-contained intra (IDR) of the resting frame — it refreshes the
        image and lets a client that dropped deltas during a flurry jump straight
        to the latest. Re-encoding advances ``frame_index`` so the PTS stays
        monotonic. For a pixel-exact settled image, use the image transport.
        """
        return self.encode(frame, force_keyframe=True)

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
            metadata={"bitstream": "annexb", "encoder": self.encoder_label},
        )


def self_test(width: int = 64, height: int = 64, frames: int = 8) -> bool:
    """Encode a few synthetic frames and decode them back to prove validity.

    Returns ``True`` if the produced Annex B bitstream decodes to a plausible
    number of frames at the expected resolution. Doubles as a runtime check
    that libx264 is actually usable.
    """
    if not h264_cpu_available():
        return False

    from ..testing import decode_annexb

    enc = H264CpuEncoder(width=width, height=height, fps=int(frames))
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
