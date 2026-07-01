"""macOS H.264 ``EncoderBackend`` via Apple VideoToolbox (``pdum.vtenc``).

The rfb wrapper around the ``habemus-papadum-vtenc`` package (``import pdum.vtenc``): it
adapts ``VtEncoder`` (host NV12 → H.264 Annex B) to the :class:`~pdum.rfb.types.EncoderBackend`
protocol so it slots into the same registry/transport seam as the libx264 and NVENC
backends. Host ``rgb24``/``rgba8`` frames are converted to NV12 on the CPU (BT.601 limited
range, matching :func:`pdum.rfb.gpu.rgb_to_nv12`); an already-NV12 frame passes straight
through. Emits the same low-latency Annex B (in-band SPS/PPS, no reordering), so the wire
format and the browser are unchanged.

The advertised codec string is taken from the **actual** emitted SPS
(``VtEncoder.codec_string``, e.g. ``avc1.420028`` at 1080p), not the constant
``avc1.42E01F`` — VideoToolbox picks the level from the resolution.

Gate on :func:`vtenc_available` before constructing one. Registered as ``"vtenc"``.
"""

from __future__ import annotations

import functools
import importlib.util
import sys

import numpy as np

from ..protocol import DEFAULT_H264_CODEC
from ..types import EncodedPayload, RawFrame

VTENC_MIN_WIDTH = 16  # VideoToolbox opens well below this; kept for parity with NVENC_MIN_WIDTH


def _contains_idr(annexb: bytes) -> bool:
    """True if the Annex B buffer carries an IDR slice (NAL unit type 5)."""
    for nal in annexb.split(b"\x00\x00\x01")[1:]:
        if nal and (nal[0] & 0x1F) == 5:
            return True
    return False


def _host_rgb_to_nv12(rgb: np.ndarray, out: np.ndarray) -> np.ndarray:
    """BT.601 limited-range RGB(A) ``(H, W, 3|4)`` → contiguous NV12 ``(H+H//2, W)``.

    Matches the coefficients of :func:`pdum.rfb.gpu.rgb_to_nv12` so a VideoToolbox stream
    and a CUDA/NVENC stream tag color identically. Even dimensions required.
    """
    h, w = rgb.shape[:2]
    r = rgb[..., 0].astype(np.float32)
    g = rgb[..., 1].astype(np.float32)
    b = rgb[..., 2].astype(np.float32)
    out[:h] = np.clip(0.257 * r + 0.504 * g + 0.098 * b + 16.0, 0, 255).astype(np.uint8)
    u = -0.148 * r - 0.291 * g + 0.439 * b + 128.0
    v = 0.439 * r - 0.368 * g - 0.071 * b + 128.0
    uv = out[h:].reshape(h // 2, w // 2, 2)
    uv[..., 0] = np.clip(u[::2, ::2], 0, 255).astype(np.uint8)
    uv[..., 1] = np.clip(v[::2, ::2], 0, 255).astype(np.uint8)
    return out


class VideoToolboxEncoder:
    """Encode host frames to H.264 Annex B via Apple VideoToolbox.

    Same constructor / :class:`~pdum.rfb.types.EncoderBackend` interface as the other H.264
    backends. Dimensions must be even (NV12).
    """

    encoder_label = "vtenc"

    def __init__(
        self,
        *,
        width: int,
        height: int,
        fps: int = 30,
        bitrate: int = 12_000_000,
        codec_string: str | None = None,
        pipeline_depth: int = 0,
    ) -> None:
        if width % 2 or height % 2:
            raise ValueError(f"NV12 requires even dimensions; got {width}x{height}")

        from pdum.vtenc import VtEncoder

        self.width = width
        self.height = height
        self.fps = fps
        self.bitrate = bitrate
        self.codec_string = codec_string or DEFAULT_H264_CODEC
        # pipeline_depth > 0 selects the token-based pipelined path (submit()/flush_pipeline);
        # 0 is the synchronous 1-in-1-out default. NOTE: on VideoToolbox specifically this is
        # *correct but not faster* — low-latency RC is synchronous (measured no throughput win,
        # see docs/pipelined_encode.md). The knob exists for the NVENC backend where it pays
        # off; VT exercises the same recovered-seq path for correctness/parity.
        self.pipeline_depth = max(0, int(pipeline_depth))
        self._pending_ts: dict[int, int] = {}  # seq -> timestamp_us for in-flight frames
        self._duration_us = int(1_000_000 / fps)
        self._nv12 = np.empty((height + height // 2, width), np.uint8)
        self._enc = VtEncoder(width, height, codec="h264", fps=fps, gop=fps, bitrate=bitrate)

    def _packed_nv12(self, frame: RawFrame) -> np.ndarray:
        data = frame.data
        if frame.memory == "metal":
            return self._packed_nv12_metal(frame)
        if frame.pixel_format == "nv12":
            arr = np.ascontiguousarray(np.asarray(data))
            if arr.shape != self._nv12.shape:
                raise ValueError(f"nv12 frame shape {arr.shape!r} != encoder {self._nv12.shape!r}")
            return arr
        if frame.pixel_format not in ("rgb24", "rgba8"):
            raise TypeError(f"VideoToolboxEncoder cannot encode {frame.pixel_format!r} frames")
        return _host_rgb_to_nv12(np.asarray(data), self._nv12)

    def _packed_nv12_metal(self, frame: RawFrame) -> np.ndarray:
        """Metal (MLX) frame: convert RGB(A)→NV12 on the GPU, then hand the binding a host NV12
        view (unified memory → near-zero-copy). Avoids the ~6.6 ms/1080p CPU color conversion."""
        from ..metal import rgb_to_nv12 as _mlx_rgb_to_nv12
        from ..metal import to_host_nv12

        if frame.pixel_format == "nv12":
            arr = to_host_nv12(frame.data)
            if arr.shape != self._nv12.shape:
                raise ValueError(f"nv12 frame shape {arr.shape!r} != encoder {self._nv12.shape!r}")
            return arr
        if frame.pixel_format not in ("rgb24", "rgba8"):
            raise TypeError(f"VideoToolboxEncoder cannot encode {frame.pixel_format!r} Metal frames")
        return to_host_nv12(_mlx_rgb_to_nv12(frame.data))

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        packed = self._packed_nv12(frame)
        if self.pipeline_depth > 0:
            return self._encode_pipelined(packed, frame.seq, frame.timestamp_us, force_keyframe)
        data = self._enc.encode(packed, force_idr=force_keyframe)
        if not data:
            return []
        # VideoToolbox derives the level from the resolution; report the real SPS string.
        self.codec_string = self._enc.codec_string or self.codec_string
        keyframe = force_keyframe or _contains_idr(data)
        return [self._payload(frame.seq, frame.timestamp_us, data, keyframe)]

    def _encode_pipelined(self, packed, seq: int, timestamp_us: int, force_keyframe: bool) -> list[EncodedPayload]:
        """Submit one frame without waiting; return whatever AUs are ready, each labeled with
        its *recovered* seq (the frame it actually encoded), not this call's seq. See
        docs/pipelined_encode.md and docs/proposals/completed/encoder_sync_and_seq_attribution.md."""
        self._pending_ts[seq] = timestamp_us
        aus = self._enc.submit(packed, seq, force_idr=force_keyframe)
        self.codec_string = self._enc.codec_string or self.codec_string
        return [self._payload(s, self._pending_ts.pop(s, timestamp_us), data, key) for s, data, key in aus]

    def flush(self) -> list[EncodedPayload]:
        if self.pipeline_depth > 0:
            aus = self._enc.flush_pipeline()
            return [self._payload(s, self._pending_ts.pop(s, 0), data, key) for s, data, key in aus]
        data = self._enc.flush()
        if not data:
            return []
        return [self._payload(-1, 0, data, _contains_idr(data))]

    def close(self) -> None:
        try:
            self._enc.close()
        except Exception:  # pragma: no cover - encoder may already be closed
            pass

    def _payload(self, seq: int, timestamp_us: int, data: bytes, keyframe: bool) -> EncodedPayload:
        return EncodedPayload(
            seq=seq,
            kind="video",
            timestamp_us=timestamp_us,
            width=self.width,
            height=self.height,
            payload=bytes(data),
            codec=self.codec_string,
            keyframe=keyframe,
            duration_us=self._duration_us,
            metadata={"bitstream": "annexb", "encoder": self.encoder_label},
        )


@functools.lru_cache(maxsize=1)
def vtenc_available() -> bool:
    """True if the VideoToolbox backend is usable in this process (cached).

    macOS + ``pdum.vtenc`` importable + VideoToolbox can open an H.264 session.
    """
    if sys.platform != "darwin" or importlib.util.find_spec("pdum.vtenc") is None:
        return False
    try:
        from pdum.vtenc import supported

        return bool(supported())
    except Exception:
        return False


def self_test(width: int = 256, height: int = 192, frames: int = 8) -> bool:
    """Encode synthetic host frames through VideoToolbox and decode them back (needs PyAV)."""
    if not vtenc_available():
        return False
    from ..testing import decode_annexb, render_test_pattern

    enc = VideoToolboxEncoder(width=width, height=height, fps=int(frames))
    chunks: list[bytes] = []
    for seq in range(frames):
        frame = RawFrame(seq, width, height, seq * 1000, "rgb24", "cpu", render_test_pattern(seq, width, height))
        for payload in enc.encode(frame, force_keyframe=(seq == 0)):
            chunks.append(payload.payload)
    for payload in enc.flush():
        chunks.append(payload.payload)
    enc.close()
    decoded = decode_annexb(b"".join(chunks))
    return bool(decoded) and all(f.width == width and f.height == height for f in decoded)
