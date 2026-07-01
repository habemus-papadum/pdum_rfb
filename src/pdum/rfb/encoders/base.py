"""Encoder registry and the ``build_encoder`` factory.

The registry is the extension seam for additional video encoders. The CPU
H.264 (PyAV/libx264) backend registers itself lazily so importing this module
never imports PyAV. The NVENC backends register themselves the same way and
:func:`pdum.rfb.protocol.select_transport` flips ``has_nvenc`` to prefer them.
"""

from __future__ import annotations

from typing import Callable

from ..protocol import BackendSelection
from ..types import EncoderBackend
from .image import ImageEncoder

#: A factory takes keyword args (width, height, fps, bitrate, codec, ...) and
#: returns an :class:`~pdum.rfb.types.EncoderBackend`.
EncoderFactory = Callable[..., EncoderBackend]

_VIDEO_ENCODERS: dict[str, EncoderFactory] = {}


def register_video_encoder(name: str, factory: EncoderFactory) -> None:
    """Register a video :class:`EncoderBackend` factory under ``name``."""
    _VIDEO_ENCODERS[name] = factory


def available_video_encoders() -> list[str]:
    """Return the names of registered video encoders."""
    return sorted(_VIDEO_ENCODERS)


# ``pipeline_depth`` is threaded to every video factory by build_encoder, but only the
# backends that implement the token-based pipelined path consume it; the rest drop it (a
# pipeline_depth > 0 request is a no-op there, run synchronously). See docs/pipelined_encode.md.
def _h264_cpu_factory(**kwargs) -> EncoderBackend:
    # Imported lazily so PyAV is only required when an H.264 encoder is built.
    from .h264_cpu import H264CpuEncoder

    kwargs.pop("pipeline_depth", None)  # libx264 path is synchronous 1-in-1-out
    return H264CpuEncoder(**kwargs)


def _nvenc_cpu_factory(**kwargs) -> EncoderBackend:
    # Imported lazily so PyAV is only required when an H.264 encoder is built.
    from .nvenc_cpu import NvencCpuEncoder

    kwargs.pop("pipeline_depth", None)  # PyAV h264_nvenc path is synchronous 1-in-1-out
    return NvencCpuEncoder(**kwargs)


def _nvenc_gpu_pyav_factory(**kwargs) -> EncoderBackend:
    # Lazy: needs PyAV >= 18 + CuPy + an NVENC GPU (gated by cuda_zerocopy_available).
    from .nvenc_gpu_pyav import NvencGpuPyavEncoder

    kwargs.pop("pipeline_depth", None)  # PyAV path is synchronous 1-in-1-out
    return NvencGpuPyavEncoder(**kwargs)


def _nvenc_gpu_pdum_factory(**kwargs) -> EncoderBackend:
    # Lazy: PyAV-free GPU path via habemus-papadum-nvenc (CuPy + an NVENC GPU);
    # gated by pdum.rfb.encoders.nvenc_gpu_pdum.nvenc_gpu_pdum_available. This is the
    # backend where pipeline_depth pays off (mapped to NVENC extra_output_delay), so it
    # *forwards* the kwarg (unlike the PyAV backends). See docs/pipelined_encode.md.
    from .nvenc_gpu_pdum import NvencGpuPdumEncoder

    return NvencGpuPdumEncoder(**kwargs)


def _vtenc_factory(**kwargs) -> EncoderBackend:
    # Lazy: macOS hardware H.264 via Apple VideoToolbox (habemus-papadum-vtenc / pdum.vtenc);
    # gated by pdum.rfb.encoders.vtenc.vtenc_available. Consumes pipeline_depth (correct but
    # not faster on VT — see docs/pipelined_encode.md).
    from .vtenc import VideoToolboxEncoder

    return VideoToolboxEncoder(**kwargs)


# The CPU H.264 backend is always *registered*; whether it can be *built* still
# depends on PyAV being importable (handled by select_transport via has_h264).
register_video_encoder("h264_cpu", _h264_cpu_factory)
# Host-input NVENC is always *registered* too; whether it can be *built* depends
# on an NVENC-capable GPU + driver (handled by select_transport via has_nvenc,
# which the server derives from pdum.rfb.encoders.nvenc_cpu.nvenc_cpu_available()).
register_video_encoder("nvenc_cpu", _nvenc_cpu_factory)
# Zero-copy CUDA→NVENC backend. Built only when the publisher pushes CUDA frames
# and the path is usable (PyAV >= 18 + CuPy + GPU); see
# pdum.rfb.gpu.cuda_zerocopy_available and serve(gpu=...).
register_video_encoder("nvenc_gpu_pyav", _nvenc_gpu_pyav_factory)
# PyAV-free GPU NVENC backend (habemus-papadum-nvenc / pdum.nvenc). serve(gpu=True)
# prefers it when available; gated by
# pdum.rfb.encoders.nvenc_gpu_pdum.nvenc_gpu_pdum_available.
register_video_encoder("nvenc_gpu_pdum", _nvenc_gpu_pdum_factory)
# macOS hardware H.264 via Apple VideoToolbox (habemus-papadum-vtenc / pdum.vtenc);
# gated by pdum.rfb.encoders.vtenc.vtenc_available.
register_video_encoder("vtenc", _vtenc_factory)


def build_encoder(
    selection: BackendSelection,
    *,
    width: int,
    height: int,
    fps: int = 30,
    bitrate: int = 12_000_000,
    video_encoder: str = "h264_cpu",
    pipeline_depth: int = 0,
) -> EncoderBackend:
    """Build the encoder backend described by ``selection``.

    Parameters
    ----------
    selection:
        The result of :func:`pdum.rfb.protocol.select_transport`.
    width, height, fps, bitrate:
        Encoder configuration (ignored by the image encoder except where noted).
    video_encoder:
        Which registered video encoder to use for the H.264 transport.
    pipeline_depth:
        Encoder pipeline depth. ``0`` (default) is synchronous 1-in-1-out (lowest latency,
        seq attribution trivially correct). ``> 0`` opts into the token-based pipelined path
        on backends that implement it (NVENC; on VideoToolbox it is correct but not faster).
        See :doc:`pipelined_encode`.
    """
    if selection.transport == "image":
        return ImageEncoder(mode=selection.image_mode or "jpeg")

    if selection.transport == "h264":
        try:
            factory = _VIDEO_ENCODERS[video_encoder]
        except KeyError as exc:
            raise ValueError(
                f"unknown video encoder {video_encoder!r}; available: {available_video_encoders()}"
            ) from exc
        return factory(
            width=width,
            height=height,
            fps=fps,
            bitrate=bitrate,
            codec_string=selection.codec,
            pipeline_depth=pipeline_depth,
        )

    raise ValueError(f"unsupported transport: {selection.transport!r}")
