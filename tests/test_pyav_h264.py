"""Tests for the PyAV/libx264 H.264 encoder.

Proves the produced Annex B bitstream is valid and decodable entirely in Python
(no browser) by decoding it back with PyAV.
"""

import numpy as np
import pytest

from pdum.rfb import RawFrame
from pdum.rfb.encoders.h264_cpu import H264CpuEncoder, h264_cpu_available, self_test
from pdum.rfb.testing import (
    decode_annexb,
    has_sps_pps_idr,
    nal_types,
    render_test_pattern,
    starts_with_start_code,
)

pytestmark = pytest.mark.skipif(not h264_cpu_available(), reason="libx264 (PyAV) not available")

W, H = 128, 96


def _frame(seq):
    return RawFrame(seq, W, H, seq * 33_000, "rgb24", "cpu", render_test_pattern(seq, W, H))


def _encode_stream(n=20):
    enc = H264CpuEncoder(width=W, height=H, fps=30)
    payloads = []
    for seq in range(n):
        payloads.extend(enc.encode(_frame(seq), force_keyframe=(seq == 0)))
    payloads.extend(enc.flush())
    enc.close()
    return payloads


def test_first_packet_is_annexb_keyframe_with_parameter_sets():
    payloads = _encode_stream()
    assert payloads, "encoder produced no packets"
    first = payloads[0]
    assert first.keyframe is True
    assert first.codec == "avc1.42E01F"
    assert starts_with_start_code(first.payload)
    assert has_sps_pps_idr(first.payload)


def test_delta_packets_have_no_parameter_sets():
    payloads = _encode_stream()
    deltas = [p for p in payloads if not p.keyframe]
    assert deltas
    for p in deltas:
        types = nal_types(p.payload)
        assert 7 not in types and 8 not in types  # no SPS/PPS in deltas


def test_mid_stream_forced_keyframe_emits_idr():
    enc = H264CpuEncoder(width=W, height=H, fps=30)
    enc.encode(_frame(0), force_keyframe=True)
    for seq in range(1, 5):
        enc.encode(_frame(seq))
    forced = enc.encode(_frame(5), force_keyframe=True)
    enc.close()
    assert any(p.keyframe and has_sps_pps_idr(p.payload) for p in forced)


def test_bitstream_decodes_back_with_pyav():
    payloads = _encode_stream(n=15)
    annexb = b"".join(p.payload for p in payloads)
    frames = decode_annexb(annexb)
    assert len(frames) >= 10  # most frames decode (a couple may stay buffered)
    assert all(f.width == W and f.height == H for f in frames)


def test_encode_still_emits_a_self_contained_idr():
    # The "still after settle" upgrade on the video path is a clean IDR (SPS+PPS+
    # IDR slice) of the resting frame, so a client can decode it standalone.
    enc = H264CpuEncoder(width=W, height=H, fps=30)
    enc.encode(_frame(0), force_keyframe=True)
    for seq in range(1, 4):
        enc.encode(_frame(seq))  # build up some delta state
    still = enc.encode_still(_frame(4))
    enc.close()
    assert still and all(p.keyframe for p in still)
    assert any(has_sps_pps_idr(p.payload) for p in still)


def test_self_test_passes():
    assert self_test() is True


def test_rejects_non_rgb24_frames():
    enc = H264CpuEncoder(width=W, height=H, fps=30)
    bad = RawFrame(0, W, H, 0, "nv12", "cpu", np.zeros((H * 3 // 2, W), dtype=np.uint8))
    with pytest.raises(TypeError):
        enc.encode(bad)
    enc.close()
