"""PyAV-free GPU H.264 encoder via the NVENC SDK (``pdum.nvenc``).

The third GPU path, and the only **PyAV-free** one. Where
:class:`~pdum.rfb.encoders.nvenc.NvencCpuEncoder` uploads a host ``rgb24`` frame and
:class:`~pdum.rfb.encoders.nvenc_gpu_pyav.NvencGpuPyavEncoder` needs **PyAV ≥ 18**, this
backend hands a GPU-resident NV12 buffer straight to NVIDIA's ``NvEncoderCuda`` (the
``habemus-papadum-nvenc`` package, ``import pdum.nvenc``) and gets **Annex B** back —
no ffmpeg/PyAV anywhere in the encode path. It is the fastest path measured on the
test hardware (see ``docs/performance.md``).

Input handling mirrors the zero-copy CUDA backend:

* a CUDA ``nv12`` frame — encoded as-is (the true zero-copy case);
* a CUDA ``rgb24``/``rgba8`` frame — converted to NV12 on the GPU first
  (:func:`pdum.rfb.gpu.rgb_to_nv12`);
* a host ``rgb24``/``rgba8`` frame — uploaded then converted (graceful fallback).

Gate on :func:`nvenc_gpu_pdum_available` before constructing one. Emits the same
low-latency Annex B as the other H.264 backends, so the wire format, forced-keyframe
handling, and payload packing are unchanged. Fixed-resolution: a resize rebuilds the
encoder (the session does this via its ``encoder_factory``) and forces a keyframe.
"""

from __future__ import annotations

import functools
import importlib.util

from ..protocol import DEFAULT_H264_CODEC
from ..types import EncodedPayload, RawFrame
from .nvenc_cpu import NVENC_MIN_WIDTH  # import-safe: no PyAV at module load


def _contains_idr(annexb: bytes) -> bool:
    """True if the Annex B buffer carries an IDR slice (NAL unit type 5).

    Start-code emulation prevention guarantees ``00 00 01`` never appears inside a
    NAL payload, so splitting on it yields exactly the NAL boundaries; the byte after
    each boundary is the NAL header whose low 5 bits are the unit type.
    """
    for nal in annexb.split(b"\x00\x00\x01")[1:]:
        if nal and (nal[0] & 0x1F) == 5:
            return True
    return False


def _codec_string_from_annexb(annexb: bytes) -> str | None:
    """Derive the WebCodecs codec string ``avc1.PPCCLL`` from the first SPS (NAL type 7).

    ``PP`` / ``CC`` / ``LL`` are the SPS ``profile_idc`` / ``constraint_set`` byte / ``level_idc``.
    NVENC's SDK encoder defaults to **High** profile (``profile_idc`` 100 → ``avc1.64xxYY``), not
    the negotiated Baseline ``avc1.42E01F``. The wrapper must advertise what the bitstream *is*:
    the browser configures its ``VideoDecoder`` from the per-chunk codec string, so a wrong one
    makes it decode against the wrong profile and fail — even though PyAV (which ignores the codec
    string and reads the SPS) decodes it fine. Returns ``None`` if no SPS is present (delta chunk).
    """
    for nal in annexb.split(b"\x00\x00\x01")[1:]:
        if nal and (nal[0] & 0x1F) == 7 and len(nal) >= 4:
            return f"avc1.{nal[1]:02X}{nal[2]:02X}{nal[3]:02X}"
    return None


class NvencGpuPdumEncoder:
    """Encode CUDA (or host, with upload) frames to H.264 Annex B via the NVENC SDK.

    Same constructor / :class:`~pdum.rfb.types.EncoderBackend` interface as the other
    H.264 backends. Frames narrower than
    :data:`~pdum.rfb.encoders.nvenc.NVENC_MIN_WIDTH` are rejected (NVENC cannot open
    below it) and dimensions must be even (NV12).
    """

    encoder_label = "nvenc-gpu-pdum"

    def __init__(
        self,
        *,
        width: int,
        height: int,
        fps: int = 30,
        bitrate: int = 12_000_000,
        codec_string: str | None = None,
        preset: str = "p4",
        tuning: str = "ll",
        pipeline_depth: int = 0,
    ) -> None:
        if width < NVENC_MIN_WIDTH:
            raise ValueError(
                f"NVENC requires width >= {NVENC_MIN_WIDTH}; got {width}. "
                "Use a larger framebuffer or fall back to the libx264 encoder."
            )
        if width % 2 or height % 2:
            raise ValueError(f"NV12 requires even dimensions; got {width}x{height}")

        import cupy as cp
        from pdum.nvenc import NvencEncoder

        self.width = width
        self.height = height
        self.fps = fps
        self.bitrate = bitrate
        self.codec_string = codec_string or DEFAULT_H264_CODEC
        # NVENC chooses the H.264 profile (High by default), which may not match `codec_string`.
        # We correct it to the real profile/level from the first SPS (see _refresh_codec_string)
        # so the browser's per-chunk VideoDecoder.configure() matches the bitstream; _codec_locked
        # guards that one-time update.
        self._codec_locked = False
        self.frame_index = 0
        self._duration_us = int(1_000_000 / fps)
        # pipeline_depth > 0 selects the token-based pipelined path (submit()/flush_pipeline);
        # 0 is the synchronous 1-in-1-out default. On NVENC this is the backend where it pays
        # off: it maps to the SDK's extra_output_delay, so several frames stay in flight and
        # encode overlaps render/convert for throughput (at depth/fps of extra latency). See
        # docs/pipelined_encode.md.
        self.pipeline_depth = max(0, int(pipeline_depth))
        self._pending_ts: dict[int, int] = {}  # seq -> timestamp_us for in-flight frames
        # Reusable NV12 staging buffer for the rgb/host input paths. ll tuning with no
        # lookahead consumes each frame before the next, so a single buffer is safe; under
        # pipelining CopyToDeviceFrame copies it into NVENC's own input slot before submit()
        # returns (the deviceSynchronize() in encode() guarantees the NV12 is ready first).
        self._nv12 = cp.empty((height + height // 2, width), cp.uint8)
        # cuda_context=0 -> retain the device *primary* context (the one CuPy uses), so
        # CuPy device pointers are valid to NVENC with no cross-context copy.
        self._enc = NvencEncoder(
            width,
            height,
            codec="h264",
            preset=preset,
            tuning=tuning,
            fps=fps,
            gop=fps,
            bitrate=bitrate,
            extra_output_delay=self.pipeline_depth,
        )

    def _packed_nv12(self, frame: RawFrame):
        """Return a contiguous CUDA NV12 ``(H+H//2, W)`` buffer for ``frame``."""
        import cupy as cp

        from ..gpu import rgb_to_nv12

        if frame.memory == "cuda" and frame.pixel_format == "nv12":
            packed = cp.ascontiguousarray(cp.asarray(frame.data))
            if packed.shape != self._nv12.shape:
                raise ValueError(f"nv12 frame shape {packed.shape!r} != encoder {self._nv12.shape!r}")
            return packed
        if frame.pixel_format not in ("rgb24", "rgba8"):
            raise TypeError(f"NvencGpuPdumEncoder cannot encode {frame.pixel_format!r} frames")
        # rgb24/rgba8, CUDA or host: convert (uploading first if host) into the buffer.
        return rgb_to_nv12(frame.data, out=self._nv12)

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        import cupy as cp

        packed = self._packed_nv12(frame)
        # Ensure the NV12 (kernel/upload above) is complete before NVENC's intra-GPU
        # copy reads it. Sub-ms at these sizes; keeps the path correct across streams.
        cp.cuda.runtime.deviceSynchronize()
        self.frame_index += 1
        if self.pipeline_depth > 0:
            return self._encode_pipelined(packed, frame.seq, frame.timestamp_us, force_keyframe)
        data = self._enc.encode(packed, force_idr=force_keyframe)
        if not data:
            return []
        self._refresh_codec_string(data)
        keyframe = force_keyframe or _contains_idr(data)
        return [self._payload(frame.seq, frame.timestamp_us, data, keyframe)]

    def _encode_pipelined(self, packed, seq: int, timestamp_us: int, force_keyframe: bool) -> list[EncodedPayload]:
        """Submit one frame without waiting; return whatever AUs are ready, each labeled with
        its *recovered* seq (the frame it actually encoded), not this call's seq. The recovered
        keyframe comes straight from NVENC's pictureType. See docs/pipelined_encode.md."""
        self._pending_ts[seq] = timestamp_us
        aus = self._enc.submit(packed, seq, force_idr=force_keyframe)
        payloads: list[EncodedPayload] = []
        for s, data, key in aus:
            self._refresh_codec_string(data)  # first emitted AU (frame 0) carries the SPS
            payloads.append(self._payload(s, self._pending_ts.pop(s, timestamp_us), data, key))
        return payloads

    def _refresh_codec_string(self, annexb: bytes) -> None:
        """Once the first SPS is seen, replace the placeholder codec string with the profile/level
        NVENC actually emitted, so every payload (and the browser's decoder) matches the bitstream.
        Idempotent after the first keyframe; a no-op on delta chunks (no SPS)."""
        if self._codec_locked:
            return
        derived = _codec_string_from_annexb(annexb)
        if derived is not None:
            self.codec_string = derived
            self._codec_locked = True

    def encode_still(self, frame: RawFrame) -> list[EncodedPayload]:
        """Settled-scene still: a forced **IDR** of the resting frame (see the CPU
        backend's :meth:`~pdum.rfb.encoders.h264_cpu.H264CpuEncoder.encode_still`)."""
        return self.encode(frame, force_keyframe=True)

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
def nvenc_gpu_pdum_available() -> bool:
    """True if the PyAV-free SDK NVENC path is usable in this process (cached).

    Checks CuPy + ``pdum.nvenc`` importable, then actually opens an NVENC session and
    encodes two frames (no decode, so it stays PyAV-free). Runs at most once per
    process because it opens a real encoder session.
    """
    if importlib.util.find_spec("cupy") is None or importlib.util.find_spec("pdum.nvenc") is None:
        return False
    try:
        import cupy as cp

        from ..gpu import cuda_frame

        enc = NvencGpuPdumEncoder(width=256, height=128, fps=4, bitrate=2_000_000)
        total = 0
        for seq in range(2):
            nv12 = cp.zeros((128 + 64, 256), cp.uint8)
            frame = cuda_frame(nv12, pixel_format="nv12", height=128, seq=seq)
            total += sum(len(p.payload) for p in enc.encode(frame, force_keyframe=(seq == 0)))
        total += sum(len(p.payload) for p in enc.flush())
        enc.close()
        return total > 0
    except Exception:
        return False


def self_test(width: int = 256, height: int = 256, frames: int = 8) -> bool:
    """Encode synthetic CUDA NV12 frames via the SDK and decode them back (needs PyAV)."""
    if not nvenc_gpu_pdum_available():
        return False

    import cupy as cp

    from ..gpu import cuda_frame
    from ..testing import decode_annexb

    width = max(width, NVENC_MIN_WIDTH)
    enc = NvencGpuPdumEncoder(width=width, height=height, fps=int(frames))
    chunks: list[bytes] = []
    for seq in range(frames):
        nv12 = cp.empty((height + height // 2, width), cp.uint8)
        nv12[:height] = (seq * 7) % 256  # moving luma
        nv12[height:] = 128  # neutral chroma
        frame = cuda_frame(nv12, pixel_format="nv12", height=height, seq=seq)
        for payload in enc.encode(frame, force_keyframe=(seq == 0)):
            chunks.append(payload.payload)
    for payload in enc.flush():
        chunks.append(payload.payload)
    enc.close()

    decoded = decode_annexb(b"".join(chunks))
    if not decoded:
        return False
    return all(f.width == width and f.height == height for f in decoded)
