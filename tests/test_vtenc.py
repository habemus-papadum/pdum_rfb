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


# --- pipelined (token-based seq attribution) path -------------------------------------


def test_pipelined_submit_recovers_seq_in_order_no_loss():
    """submit()/flush_pipeline() return AUs tagged with the *recovered* seq, every frame
    accounted for exactly once, in input order (no B-frames). See docs/pipelined_encode.md."""
    from pdum.vtenc import VtEncoder

    n = 24
    enc = VtEncoder(W, H, fps=30, gop=30, bitrate=6_000_000)
    seqs, keys, blob = [], [], b""
    for seq in range(n):
        for s, data, key in enc.submit(_moving_nv12(seq), seq=seq, force_idr=(seq == 0)):
            assert isinstance(s, int) and isinstance(data, bytes) and isinstance(key, bool)
            seqs.append(s)
            keys.append(key)
            blob += data
    for s, data, key in enc.flush_pipeline():
        seqs.append(s)
        keys.append(key)
        blob += data
    enc.close()
    assert seqs == list(range(n)), f"recovered seqs must be 0..{n - 1} in order; got {seqs}"
    assert keys[0] and not any(keys[1:]), "only frame 0 is a keyframe (gop=30 > n)"
    frames = decode_annexb(blob)
    assert len(frames) >= n - 1
    assert all(f.width == W and f.height == H for f in frames)


def test_wrapper_pipeline_depth_recovers_seq():
    """The rfb wrapper in pipelined mode labels each payload with the recovered seq."""
    from pdum.rfb.encoders.vtenc import VideoToolboxEncoder
    from pdum.rfb.types import RawFrame

    n = 16
    enc = VideoToolboxEncoder(width=W, height=H, fps=16, pipeline_depth=2)
    seqs, blob = [], b""
    for i in range(n):
        frame = RawFrame(i, W, H, i * 1000, "nv12", "cpu", _moving_nv12(i))
        for p in enc.encode(frame, force_keyframe=(i == 0)):
            seqs.append(p.seq)
            blob += p.payload
            assert p.metadata["bitstream"] == "annexb"
    for p in enc.flush():
        seqs.append(p.seq)
        blob += p.payload
    enc.close()
    assert seqs == list(range(n)), f"payload seqs must be recovered tokens; got {seqs}"
    assert len(decode_annexb(blob)) >= n - 1


def test_build_encoder_threads_pipeline_depth_to_vtenc():
    """serve(encode_pipeline_depth=)'s plumbing: build_encoder forwards it to the wrapper."""
    from pdum.rfb.encoders.base import build_encoder
    from pdum.rfb.encoders.vtenc import VideoToolboxEncoder
    from pdum.rfb.protocol import DEFAULT_H264_CODEC, BackendSelection

    selection = BackendSelection(transport="h264", codec=DEFAULT_H264_CODEC)
    enc = build_encoder(selection, width=W, height=H, fps=30, video_encoder="vtenc", pipeline_depth=3)
    assert isinstance(enc, VideoToolboxEncoder) and enc.pipeline_depth == 3
    enc.close()


# --- offline benchmark integration --------------------------------------------------


def test_benchmark_vtenc_cpu_path():
    """benchmark_vtenc runs the CPU-convert path (MLX-independent) and decodes back."""
    from pdum.rfb.benchmark import _vtenc_available, benchmark_vtenc

    assert _vtenc_available()  # module is skipped unless VideoToolbox works
    r = benchmark_vtenc(bitrate=4_000_000, frames=8, width=W, height=H, fps=8, use_mlx=False)
    assert r.encoder == "vtenc" and r.label.startswith("vtenc-cpu")
    assert r.encode_ms_mean > 0 and r.bytes_per_frame > 0
    assert r.psnr_db > 20  # the gradient decodes back to something faithful


def test_benchmark_vtenc_mlx_gpu_path_when_available():
    """When MLX is present, benchmark_vtenc times the on-GPU RGB→NV12 + encode."""
    from pdum.rfb.metal import mlx_available

    if not mlx_available():
        pytest.skip("MLX (Apple Metal) not available")
    from pdum.rfb.benchmark import benchmark_vtenc

    r = benchmark_vtenc(bitrate=4_000_000, frames=8, width=W, height=H, fps=8, use_mlx=True)
    assert r.encoder == "vtenc" and r.label.startswith("vtenc-gpu")
    assert r.encode_ms_mean > 0 and r.psnr_db > 20


def test_encode_still_emits_forced_idr():
    """VideoToolboxEncoder.encode_still re-encodes as a self-contained keyframe (IDR), so the
    session's "still after settle" fires on the macOS video path instead of silently no-oping."""
    from pdum.rfb.encoders.vtenc import VideoToolboxEncoder
    from pdum.rfb.types import RawFrame

    enc = VideoToolboxEncoder(width=W, height=H, fps=8)
    enc.encode(RawFrame(0, W, H, 0, "nv12", "cpu", _moving_nv12(0)), force_keyframe=True)
    payloads = enc.encode_still(RawFrame(1, W, H, 1000, "nv12", "cpu", _moving_nv12(1)))
    enc.close()
    assert payloads and payloads[0].keyframe
    assert has_sps_pps_idr(b"".join(p.payload for p in payloads))
