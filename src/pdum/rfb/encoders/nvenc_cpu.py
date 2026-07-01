"""Hardware H.264 encoder via NVIDIA NVENC (the roadmap's GPU backend).

This rides on **PyAV's bundled ffmpeg** rather than NVIDIA's ``PyNvVideoCodec``:
the ``av`` wheel ships an ffmpeg built with ``--enable-nvenc``, exposing the
``h264_nvenc`` encoder, which ``dlopen``\\s ``libnvidia-encode`` at runtime. So
this backend needs no Python dependency beyond ``av`` (already the ``h264`` /
``nvenc`` extra) — only a host NVIDIA driver + an NVENC-capable GPU, which pip
cannot install.

Like :class:`~pdum.rfb.encoders.h264_cpu.H264CpuEncoder` it emits **Annex B**
access units (in-band SPS/PPS on key frames) configured for low latency
(``preset=p4``/``tune=ll``, no B-frames, ~1 s forced-IDR cadence). It subclasses
the libx264 encoder and only swaps the underlying ``av.CodecContext``, so the
frame conversion, forced-keyframe handling, and payload packing are shared.

Availability is gated by :func:`nvenc_cpu_available`, which checks the OS, that PyAV
exposes ``h264_nvenc``, and that the encoder actually opens on the GPU.
"""

from __future__ import annotations

import sys
import time
from fractions import Fraction

from ..protocol import DEFAULT_H264_CODEC
from .h264_cpu import H264CpuEncoder, h264_available

#: NVENC H.264 has a hardware minimum frame width (160 on the tested Ada GPU;
#: widths <160 fail ``avcodec_open2`` with EINVAL). Height may be smaller.
NVENC_MIN_WIDTH = 160

#: OSes where NVENC can exist. macOS has no NVIDIA driver / NVENC.
_NVENC_PLATFORMS = ("linux", "win32", "cygwin")

#: Codec name in PyAV/ffmpeg for the NVENC H.264 encoder.
_NVENC_CODEC = "h264_nvenc"

# Cache the probe result: opening an NVENC session is not free and consumer GPUs
# cap concurrent sessions, so we never want to probe more than once per process.
_nvenc_ok: bool | None = None


def nvenc_codec_available() -> bool:
    """True if PyAV is importable and lists the ``h264_nvenc`` encoder.

    This is a cheap, side-effect-free check (it does not touch the GPU). It is
    necessary but not sufficient — the encoder still has to *open* on a real
    device, which :func:`nvenc_cpu_available` verifies.
    """
    if sys.platform not in _NVENC_PLATFORMS:
        return False
    if not h264_available():
        return False
    try:
        import av

        return _NVENC_CODEC in av.codecs_available
    except Exception:  # pragma: no cover - defensive
        return False


def _probe_open(retries: int = 3) -> bool:
    """Actually open + encode one frame on the GPU to prove NVENC is usable.

    Consumer GPUs cap concurrent NVENC sessions and rapid open/close churn can
    transiently return EINVAL, so the probe retries a few times before giving up.
    """
    import av
    import numpy as np

    w = h = 256  # comfortably above NVENC_MIN_WIDTH
    for _attempt in range(retries):
        try:
            ctx = av.CodecContext.create(_NVENC_CODEC, "w")
            ctx.width = w
            ctx.height = h
            ctx.pix_fmt = "yuv420p"
            ctx.time_base = Fraction(1, 30)
            ctx.framerate = Fraction(30, 1)
            ctx.bit_rate = 2_000_000
            vf = av.VideoFrame.from_ndarray(np.zeros((h, w, 3), dtype=np.uint8), format="rgb24")
            vf = vf.reformat(format="yuv420p")
            vf.pts = 0
            vf.time_base = Fraction(1, 30)
            list(ctx.encode(vf))
            list(ctx.encode(None))  # flush; PyAV CodecContext has no close()
            return True
        except Exception:  # pragma: no cover - hardware/driver dependent
            time.sleep(0.25)
    return False


def nvenc_cpu_available() -> bool:
    """True if a usable NVENC H.264 encoder is present (cached).

    Guards, in order: the OS must be one where NVENC exists (not macOS); PyAV
    must expose ``h264_nvenc``; and the encoder must actually open and encode a
    frame on the GPU (which requires an NVENC-capable device and a working
    driver). The result is cached for the lifetime of the process.
    """
    global _nvenc_ok
    if _nvenc_ok is not None:
        return _nvenc_ok
    if not nvenc_codec_available():
        _nvenc_ok = False
        return _nvenc_ok
    _nvenc_ok = _probe_open()
    return _nvenc_ok


class NvencCpuEncoder(H264CpuEncoder):
    """Encode CPU ``rgb24`` frames to H.264 Annex B on the GPU via NVENC.

    Drop-in for :class:`H264CpuEncoder` (same constructor and ``EncoderBackend``
    interface); only the underlying codec context differs. Frames narrower than
    :data:`NVENC_MIN_WIDTH` are rejected because NVENC cannot open below it.
    """

    encoder_label = "nvenc-cpu"

    def __init__(
        self,
        *,
        width: int,
        height: int,
        fps: int = 30,
        bitrate: int = 12_000_000,
        codec_string: str | None = None,
        color: dict | None = None,
    ) -> None:
        if width < NVENC_MIN_WIDTH:
            raise ValueError(
                f"NVENC requires width >= {NVENC_MIN_WIDTH}; got {width}. "
                "Use a larger framebuffer or fall back to the libx264 encoder."
            )
        super().__init__(
            width=width,
            height=height,
            fps=fps,
            bitrate=bitrate,
            codec_string=codec_string or DEFAULT_H264_CODEC,
            color=color,
        )

    def _make_context(self):
        import av

        ctx = av.CodecContext.create(_NVENC_CODEC, "w")
        ctx.width = self.width
        ctx.height = self.height
        ctx.pix_fmt = "yuv420p"
        ctx.time_base = Fraction(1, self.fps)
        ctx.framerate = Fraction(self.fps, 1)
        ctx.bit_rate = self.bitrate
        # Low latency: fast preset, low-latency tune, no B-frames, immediate
        # output, ~1 s forced-IDR cadence. ``rc=vbr`` treats ``bit_rate`` as a
        # target/ceiling and lets the stream **undershoot** on static frames —
        # critical for sparse scientific scenes (CBR would pad to the full bitrate
        # even when nothing changed, ~60x more bytes for identical quality, and
        # mirrors how the libx264 ABR path already behaves). ``profile=baseline``
        # makes the SPS advertise profile_idc 66 to match the negotiated
        # ``avc1.42E01F`` codec string (NVENC otherwise defaults to main/high).
        # NVENC emits Annex B with in-band SPS/PPS on every IDR for a raw stream.
        ctx.options = {
            "preset": "p4",
            "tune": "ll",
            "rc": "vbr",
            "profile": "baseline",
            "bf": "0",
            "delay": "0",
            "forced-idr": "1",
            "g": str(self.fps),
        }
        return ctx


def self_test(width: int = 256, height: int = 256, frames: int = 8) -> bool:
    """Encode a few synthetic frames via NVENC and decode them back with PyAV.

    Returns ``True`` if the produced Annex B bitstream decodes to a plausible
    number of frames at the expected resolution. Doubles as a runtime check that
    NVENC is actually usable end-to-end.
    """
    if not nvenc_cpu_available():
        return False

    import numpy as np

    from ..testing import decode_annexb
    from ..types import RawFrame

    width = max(width, NVENC_MIN_WIDTH)
    enc = NvencCpuEncoder(width=width, height=height, fps=int(frames))
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
