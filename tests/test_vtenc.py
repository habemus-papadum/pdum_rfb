"""Tests for the macOS VideoToolbox H.264 encoder (``pdum.vtenc``).

Mirrors ``test_nvenc.py``: proves the produced Annex B bitstream is valid and decodable
entirely in Python (decoded back with PyAV). The whole module is skipped unless macOS
VideoToolbox can actually open an H.264 session, so CI on non-Apple machines stays green.

The ``pdum.rfb`` ``EncoderBackend``/``serve()`` wiring is deferred, so these tests drive
``VtEncoder`` directly with host NV12 (numpy) — the same contract MLX feeds in the
end-to-end example (``examples/mlx_vt_stream.py``).
"""

from __future__ import annotations

import functools
import sys

import numpy as np
import pytest

from pdum.rfb.testing import (
    decode_annexb,
    has_sps_pps_idr,
    nal_types,
    starts_with_start_code,
)


@functools.lru_cache(maxsize=1)
def vtenc_available() -> bool:
    """True if VideoToolbox H.264 encode works in this process (cached).

    macOS + ``pdum.vtenc`` importable + a real one-frame encode. This is the test-side
    gate; the productionized ``vtenc_available()`` lands with the deferred
    ``pdum.rfb.encoders.vtenc`` backend.
    """
    if sys.platform != "darwin":
        return False
    try:
        from pdum.vtenc import VtEncoder, supported

        if not supported():
            return False
        enc = VtEncoder(64, 64, fps=4, bitrate=1_000_000)
        out = enc.encode(np.zeros((64 + 32, 64), np.uint8), force_idr=True)
        out += enc.flush()
        enc.close()
        return len(out) > 0
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not vtenc_available(), reason="VideoToolbox H.264 not available")

W, H = 256, 192  # even dimensions; small for speed


def _moving_nv12(seq: int, width: int = W, height: int = H) -> np.ndarray:
    """A contiguous (H + H//2, W) NV12 frame: moving luma, neutral chroma."""
    nv12 = np.empty((height + height // 2, width), np.uint8)
    cols = np.arange(width)[None, :]
    rows = np.arange(height)[:, None]
    nv12[:height] = ((cols + rows + seq * 4) & 0xFF).astype(np.uint8)
    nv12[height:] = 128
    return nv12


def _rgb_to_nv12(rgb: np.ndarray) -> np.ndarray:
    """BT.601 limited-range RGB(H,W,3 uint8) -> contiguous NV12, matching gpu.rgb_to_nv12."""
    h, w, _ = rgb.shape
    r, g, b = (rgb[..., i].astype(np.float32) for i in range(3))
    y = 0.257 * r + 0.504 * g + 0.098 * b + 16
    u = -0.148 * r - 0.291 * g + 0.439 * b + 128
    v = 0.439 * r - 0.368 * g - 0.071 * b + 128
    nv12 = np.empty((h + h // 2, w), np.uint8)
    nv12[:h] = np.clip(y, 0, 255).astype(np.uint8)
    uv = nv12[h:].reshape(h // 2, w // 2, 2)
    uv[..., 0] = np.clip(u[::2, ::2], 0, 255).astype(np.uint8)
    uv[..., 1] = np.clip(v[::2, ::2], 0, 255).astype(np.uint8)
    return nv12


def _encode_stream(n: int = 20):
    from pdum.vtenc import VtEncoder

    enc = VtEncoder(W, H, fps=30, gop=30, bitrate=6_000_000)
    chunks = []
    for seq in range(n):
        chunks.append(enc.encode(_moving_nv12(seq), force_idr=(seq == 0)))
    chunks.append(enc.flush())
    cs = enc.codec_string
    enc.close()
    return [c for c in chunks if c], cs


def test_supported_returns_bool():
    from pdum.vtenc import supported

    assert isinstance(supported(), bool)


def test_first_packet_is_annexb_keyframe_with_parameter_sets():
    chunks, _ = _encode_stream()
    assert chunks, "encoder produced no packets"
    first = chunks[0]
    assert starts_with_start_code(first)
    assert has_sps_pps_idr(first)  # SPS(7) + PPS(8) + IDR(5)


def test_stream_decodes_back_to_right_dimensions():
    chunks, _ = _encode_stream()
    stream = b"".join(chunks)
    frames = decode_annexb(stream)
    assert len(frames) >= 1
    assert all(f.width == W and f.height == H for f in frames)


def test_delta_frames_carry_no_parameter_sets():
    chunks, _ = _encode_stream(n=10)
    # Frame 0 is the only keyframe (gop=30 > 10); the rest are pure delta slices.
    for c in chunks[1:]:
        types = nal_types(c)
        assert 7 not in types and 8 not in types and 5 not in types, types
        assert 1 in types  # non-IDR slice


def test_force_idr_midstream_emits_a_keyframe():
    from pdum.vtenc import VtEncoder

    enc = VtEncoder(W, H, fps=30, gop=300, bitrate=6_000_000)  # gop huge so no auto-IDR
    enc.encode(_moving_nv12(0), force_idr=True)
    mid = b"".join(enc.encode(_moving_nv12(s), force_idr=(s == 5)) for s in range(1, 10))
    enc.close()
    assert has_sps_pps_idr(mid), "forced mid-stream IDR did not produce SPS/PPS/IDR"


def test_codec_string_derived_from_sps():
    _, cs = _encode_stream(n=4)
    # VideoToolbox baseline; level is resolution-derived (256x192 -> low level).
    assert cs.startswith("avc1.42"), cs


def test_color_roundtrip_solid_frame():
    from pdum.vtenc import VtEncoder

    rgb = np.empty((H, W, 3), np.uint8)
    rgb[:] = (40, 160, 210)  # a distinct teal-ish color (solid: no 4:2:0 edge issues)
    enc = VtEncoder(W, H, fps=10, bitrate=10_000_000)
    stream = b"".join(enc.encode(_rgb_to_nv12(rgb), force_idr=True) for _ in range(3))
    stream += enc.flush()
    enc.close()
    frames = decode_annexb(stream)
    assert frames, "no decoded frames"
    out = frames[-1].to_ndarray(format="rgb24")
    mean = out.reshape(-1, 3).mean(axis=0)
    # H.264 + BT.601 round-trip is lossy; allow a generous tolerance.
    assert np.allclose(mean, (40, 160, 210), atol=24), mean
