"""Tests for the hardware NVENC H.264 encoder.

Mirrors ``test_pyav_h264.py``: proves the produced Annex B bitstream is valid and
decodable entirely in Python (decoded back with PyAV). The whole module is
skipped unless an NVENC-capable GPU + driver is actually present, so CI on
machines without an NVIDIA GPU stays green.

Frame sizes are kept at/above ``NVENC_MIN_WIDTH`` (160) because NVENC cannot open
below it. Encoders are created sparingly: consumer GPUs cap concurrent NVENC
sessions, so each encoder is closed before the next is built.
"""

import numpy as np
import pytest

from pdum.rfb import RawFrame
from pdum.rfb.encoders.nvenc import (
    NVENC_MIN_WIDTH,
    NvencH264Encoder,
    nvenc_available,
    self_test,
)
from pdum.rfb.testing import (
    decode_annexb,
    has_sps_pps_idr,
    nal_types,
    render_test_pattern,
    starts_with_start_code,
)

pytestmark = pytest.mark.skipif(not nvenc_available(), reason="NVENC-capable GPU not available")

W, H = 256, 192  # both comfortably above the NVENC minimum width


def _frame(seq):
    return RawFrame(seq, W, H, seq * 33_000, "rgb24", "cpu", render_test_pattern(seq, W, H))


def _encode_stream(n=20):
    enc = NvencH264Encoder(width=W, height=H, fps=30)
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
    assert first.metadata["encoder"] == "pyav-nvenc"
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
    enc = NvencH264Encoder(width=W, height=H, fps=30)
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


def test_self_test_passes():
    assert self_test() is True


def test_rejects_non_rgb24_frames():
    enc = NvencH264Encoder(width=W, height=H, fps=30)
    bad = RawFrame(0, W, H, 0, "nv12", "cpu", np.zeros((H * 3 // 2, W), dtype=np.uint8))
    with pytest.raises(TypeError):
        enc.encode(bad)
    enc.close()


def test_rejects_width_below_nvenc_minimum():
    with pytest.raises(ValueError, match="width"):
        NvencH264Encoder(width=NVENC_MIN_WIDTH - 16, height=H, fps=30)
