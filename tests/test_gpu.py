"""Tests for the zero-copy CUDA→NVENC path (:mod:`pdum.rfb.gpu` + ``nvenc_cuda``).

Three tiers, by what the host provides:

* always-on: registry wiring, gates return ``bool``, ``publish`` type-checks — no
  CuPy needed (these run in CI);
* ``requires_cupy``: CuPy installed (kernels, planes, ``cuda_frame``, ``publish``);
* ``requires_zerocopy``: the full stack — CuPy + an NVENC GPU + PyAV ≥ 18 — so an
  actual zero-copy encode can run and decode back.

On the stock CI environment (no CuPy, PyAV 17.x) the GPU tiers skip.
"""

from __future__ import annotations

import importlib.util

import numpy as np
import pytest

from pdum.rfb import gpu
from pdum.rfb.encoders.base import available_video_encoders

HAS_CUPY = importlib.util.find_spec("cupy") is not None
ZEROCOPY = HAS_CUPY and gpu.cuda_zerocopy_available()

requires_cupy = pytest.mark.skipif(not HAS_CUPY, reason="cupy not installed")
requires_zerocopy = pytest.mark.skipif(
    not ZEROCOPY, reason="zero-copy CUDA NVENC unavailable (needs CuPy + NVENC GPU + PyAV>=18)"
)


# --- always-on (no CuPy) ----------------------------------------------------


def test_nvenc_cuda_registered():
    assert "nvenc_cuda" in available_video_encoders()


def test_gates_return_bool():
    assert isinstance(gpu.cuda_zerocopy_available(), bool)
    assert isinstance(gpu.enable_cuda_context_sharing(), bool)


def test_publish_rejects_unknown_object():
    from pdum.rfb import Display

    d = Display(8, 8)
    with pytest.raises(TypeError):
        d.publish(object())


def test_serve_gpu_raises_when_unavailable():
    import asyncio

    from pdum.rfb.server import serve

    if ZEROCOPY:
        pytest.skip("zero-copy stack available; this asserts the *unavailable* path")
    with pytest.raises(RuntimeError):
        asyncio.run(serve(256, 256, port=0, gpu=True))


def test_to_host_rgb_passthrough_for_cpu_frame():
    # CPU frames need no CuPy and pass through (alpha dropped).
    from pdum.rfb.types import RawFrame

    rgb = np.zeros((4, 6, 3), np.uint8)
    out = gpu.to_host_rgb(RawFrame(0, 6, 4, 0, "rgb24", "cpu", rgb))
    assert out.shape == (4, 6, 3)
    rgba = np.zeros((4, 6, 4), np.uint8)
    out2 = gpu.to_host_rgb(RawFrame(0, 6, 4, 0, "rgba8", "cpu", rgba))
    assert out2.shape == (4, 6, 3)


# --- requires CuPy ----------------------------------------------------------


@requires_cupy
def test_rgb_to_nv12_layout_is_contiguous():
    import cupy as cp

    gpu.enable_cuda_context_sharing()
    h, w = 64, 48
    rgb = cp.asarray((np.random.rand(h, w, 3) * 255).astype(np.uint8))
    nv12 = gpu.rgb_to_nv12(rgb)
    assert nv12.shape == (h + h // 2, w)
    y, uv = gpu.nv12_planes(nv12)
    assert y.shape == (h, w) and uv.shape == (h // 2, w)
    # The UV plane must sit immediately after Y in one allocation (NVENC needs this).
    assert int(uv.data.ptr) - int(y.data.ptr) == w * h


@requires_cupy
def test_rgb_to_nv12_grayscale_values():
    import cupy as cp

    h, w = 64, 64
    gray = np.full((h, w, 3), 123, np.uint8)
    y, uv = gpu.nv12_planes(gpu.rgb_to_nv12(cp.asarray(gray)))
    # BT.601 limited: gray 123 -> Y ~122, chroma neutral ~128.
    assert 112 < float(cp.asnumpy(y).mean()) < 132
    assert 122 < float(cp.asnumpy(uv).mean()) < 134


@requires_cupy
def test_cuda_frame_inference():
    import cupy as cp

    f = gpu.cuda_frame(cp.zeros((10, 8, 3), cp.uint8))
    assert f.memory == "cuda" and f.pixel_format == "rgb24" and (f.height, f.width) == (10, 8)
    g = gpu.cuda_frame(cp.zeros((15, 8), cp.uint8), pixel_format="nv12", height=10)
    assert g.pixel_format == "nv12" and g.height == 10 and g.width == 8


@requires_cupy
def test_publish_accepts_cupy_tensor():
    import cupy as cp

    from pdum.rfb import Display

    d = Display(8, 8)
    d.publish(cp.zeros((12, 16, 3), cp.uint8))
    assert d._latest.memory == "cuda" and d._latest.pixel_format == "rgb24"
    assert (d.height, d.width) == (12, 16)


# --- requires the full zero-copy stack (CuPy + NVENC GPU + PyAV>=18) ---------


@pytest.fixture(autouse=True)
def _release_nvenc_sessions():
    # PyAV's CodecContext has no close(); the NVENC session is freed when it is
    # GC'd. Consumer GPUs transiently EINVAL on rapid open/close churn, so collect
    # before and after each test to release sessions promptly between encoders.
    import gc

    gc.collect()
    yield
    gc.collect()


def _encode_frames(w, h, make_frame, n=12, attempts=3):
    """Encode ``n`` frames through a fresh ``CudaNvencEncoder``, retrying transient
    NVENC churn errors (a consumer-GPU quirk; production uses one long-lived
    encoder per connection and is unaffected)."""
    import gc

    from pdum.rfb.encoders.nvenc_cuda import CudaNvencEncoder

    last: Exception | None = None
    for _ in range(attempts):
        try:
            enc = CudaNvencEncoder(width=w, height=h, fps=30)
            chunks: list[bytes] = []
            for s in range(n):
                chunks += [p.payload for p in enc.encode(make_frame(s), force_keyframe=(s == 0))]
            chunks += [p.payload for p in enc.flush()]
            enc.close()
            return chunks
        except Exception as exc:  # transient NVENC EINVAL under churn
            last = exc
            gc.collect()
    raise last  # pragma: no cover - all attempts failed


@requires_zerocopy
def test_self_test_nv12_round_trip():
    from pdum.rfb.encoders import nvenc_cuda

    assert any(nvenc_cuda.self_test(256, 256, 8) for _ in range(3))


@requires_zerocopy
def test_encode_cuda_rgb_decodes_back():
    import cupy as cp

    from pdum.rfb.testing import decode_annexb

    w, h = 256, 192
    rgb = cp.asarray((np.random.rand(h, w, 3) * 255).astype(np.uint8))
    chunks = _encode_frames(w, h, lambda s: gpu.cuda_frame(rgb, seq=s))
    decoded = decode_annexb(b"".join(chunks))
    assert len(decoded) >= 10
    assert all(f.width == w and f.height == h for f in decoded)


@requires_zerocopy
def test_encode_host_rgb_fallback_decodes_back():
    from pdum.rfb.testing import decode_annexb
    from pdum.rfb.types import RawFrame

    w, h = 256, 192

    def host_frame(s):
        return RawFrame(s, w, h, 0, "rgb24", "cpu", np.full((h, w, 3), (s * 9) % 256, np.uint8))

    chunks = _encode_frames(w, h, host_frame)
    assert len(decode_annexb(b"".join(chunks))) >= 10


@requires_zerocopy
def test_host_frame_adapter_downloads_cuda_nv12():
    import cupy as cp

    from pdum.rfb.encoders.image import ImageEncoder

    w, h = 64, 48
    adapted = gpu.HostFrameAdapter(ImageEncoder(mode="jpeg"))
    nv12 = gpu.rgb_to_nv12(cp.asarray((np.random.rand(h, w, 3) * 255).astype(np.uint8)))
    out = adapted.encode(gpu.cuda_frame(nv12, pixel_format="nv12", height=h))
    assert out and out[0].mime and len(out[0].payload) > 0
