"""Zero-copy CUDA → NVENC H.264 encoder (the roadmap's GPU-buffer path).

Unlike :class:`~pdum.rfb.encoders.nvenc.NvencH264Encoder` — which takes a host
``rgb24`` frame, reformats it to ``yuv420p`` on the CPU, and lets NVENC upload it
— this backend encodes a **CUDA-resident** frame directly: a CuPy / DLPack NV12
buffer is handed to ``h264_nvenc`` via ``av.VideoFrame.from_dlpack`` with no host
round-trip. On the tested Ada laptop GPU that is ~2.4–4.3× lower per-frame latency
(1080p 2.5 ms vs 7.3 ms; 4K 7.1 ms vs 30.5 ms) and frees the CPU entirely — see
``docs/gpu_zerocopy.md``.

It accepts:

* a CUDA ``nv12`` frame (``RawFrame(memory="cuda", pixel_format="nv12")``) — the
  true zero-copy case; the device buffer is encoded as-is;
* a CUDA ``rgb24``/``rgba8`` frame — converted to NV12 on the GPU first
  (:func:`pdum.rfb.gpu.rgb_to_nv12`, ~0.01 ms at 1080p);
* a host ``rgb24``/``rgba8`` frame — uploaded then converted (graceful fallback so
  a ``gpu=True`` server still works if the publisher pushes a host frame).

**Requires PyAV ≥ 18** (or a from-source build with the CUDA-encode fix). Gate on
:func:`pdum.rfb.gpu.cuda_zerocopy_available` before constructing one. Emits the
same low-latency Annex B as the other H.264 backends, so the wire format,
forced-keyframe handling, and payload packing are inherited unchanged.
"""

from __future__ import annotations

from fractions import Fraction

from ..gpu import cuda_zerocopy_available, enable_cuda_context_sharing, nv12_planes, rgb_to_nv12
from ..protocol import DEFAULT_H264_CODEC
from .nvenc import _NVENC_CODEC, NVENC_MIN_WIDTH
from .pyav_h264 import PyAvH264Encoder


def cuda_nvenc_available() -> bool:
    """True if the zero-copy CUDA→NVENC path is usable (see :func:`cuda_zerocopy_available`)."""
    return cuda_zerocopy_available()


class CudaNvencEncoder(PyAvH264Encoder):
    """Encode CUDA (or host, with upload) frames to H.264 Annex B via NVENC, zero-copy.

    Drop-in for :class:`~pdum.rfb.encoders.nvenc.NvencH264Encoder` (same
    constructor / ``EncoderBackend`` interface); only the input handling differs.
    Frames narrower than :data:`~pdum.rfb.encoders.nvenc.NVENC_MIN_WIDTH` are
    rejected (NVENC cannot open below it), and dimensions must be even (NV12).
    """

    encoder_label = "pyav-nvenc-cuda"

    def __init__(
        self,
        *,
        width: int,
        height: int,
        fps: int = 30,
        bitrate: int = 12_000_000,
        codec_string: str | None = None,
    ) -> None:
        if width < NVENC_MIN_WIDTH:
            raise ValueError(
                f"NVENC requires width >= {NVENC_MIN_WIDTH}; got {width}. "
                "Use a larger framebuffer or fall back to the libx264 encoder."
            )
        if width % 2 or height % 2:
            raise ValueError(f"NV12 requires even dimensions; got {width}x{height}")
        # Share CuPy's primary CUDA context with FFmpeg (must precede CuPy use; a
        # no-op if the caller already did it at startup, as recommended).
        enable_cuda_context_sharing()
        self._cctx = None
        self._nv12 = None  # reusable NV12 staging buffer for the rgb/host paths
        super().__init__(
            width=width,
            height=height,
            fps=fps,
            bitrate=bitrate,
            codec_string=codec_string or DEFAULT_H264_CODEC,
        )

    def _make_context(self):
        import av
        import cupy as cp
        from av.video.frame import CudaContext

        # One persistent CUDA context shared by every from_dlpack frame and the
        # encoder, so all frames carry the same hw_frames_ctx.
        self._cctx = CudaContext(device_id=0, primary_ctx=True)
        self._nv12 = cp.empty((self.height + self.height // 2, self.width), cp.uint8)

        ctx = av.CodecContext.create(_NVENC_CODEC, "w")
        ctx.width = self.width
        ctx.height = self.height
        ctx.pix_fmt = "cuda"  # the key difference: GPU-resident input
        ctx.time_base = Fraction(1, self.fps)
        ctx.framerate = Fraction(self.fps, 1)
        ctx.bit_rate = self.bitrate
        # Same low-latency config as the host NVENC backend (see its docstring for
        # the rc=vbr / profile=baseline rationale).
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

    def _packed_nv12(self, frame):
        """Return a contiguous CUDA NV12 ``(H+H//2, W)`` buffer for ``frame``."""
        import cupy as cp

        if frame.memory == "cuda" and frame.pixel_format == "nv12":
            packed = cp.ascontiguousarray(cp.asarray(frame.data))
            if packed.shape != self._nv12.shape:
                raise ValueError(f"nv12 frame shape {packed.shape!r} != encoder {self._nv12.shape!r}")
            return packed
        if frame.pixel_format not in ("rgb24", "rgba8"):
            raise TypeError(f"CudaNvencEncoder cannot encode {frame.pixel_format!r} frames")
        # rgb24/rgba8, CUDA or host: convert (uploading first if host) into the
        # reusable staging buffer. delay=0 means the prior frame is fully consumed
        # before we overwrite, so a single reused buffer is safe.
        return rgb_to_nv12(frame.data, out=self._nv12)

    def encode(self, frame, *, force_keyframe: bool = False):
        import av

        packed = self._packed_nv12(frame)
        y, uv = nv12_planes(packed)
        vf = av.VideoFrame.from_dlpack(
            [y, uv],
            format="nv12",
            width=self.width,
            height=self.height,
            primary_ctx=True,
            cuda_context=self._cctx,
        )
        vf.pts = self.frame_index
        vf.time_base = Fraction(1, self.fps)
        if force_keyframe:
            vf.pict_type = av.video.frame.PictureType.I
        self.frame_index += 1
        return [self._payload(frame.seq, frame.timestamp_us, pkt) for pkt in self._drain(vf)]


def self_test(width: int = 256, height: int = 256, frames: int = 8) -> bool:
    """Encode a few synthetic CUDA NV12 frames via zero-copy NVENC and decode back."""
    if not cuda_nvenc_available():
        return False

    import cupy as cp

    from ..gpu import cuda_frame
    from ..testing import decode_annexb

    width = max(width, NVENC_MIN_WIDTH)
    enc = CudaNvencEncoder(width=width, height=height, fps=int(frames))
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
