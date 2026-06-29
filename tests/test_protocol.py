"""Tests for the binary envelope and capability negotiation."""

import json
import struct

import pytest

from pdum.rfb.protocol import pack_binary_message, unpack_binary_message
from pdum.rfb.testing import gen_fixtures


def test_round_trip_image_header():
    header = {"type": "image_frame", "seq": 42, "width": 1280, "height": 720, "mime": "image/jpeg"}
    payload = bytes([0xFF, 0xD8, 0xFF, 0xE0])
    h, p = unpack_binary_message(pack_binary_message(header, payload))
    assert h == header
    assert p == payload


def test_round_trip_video_header():
    header = {"type": "video_chunk", "seq": 7, "codec": "avc1.42E01F", "keyframe": True}
    payload = bytes([0x00, 0x00, 0x00, 0x01, 0x67])
    h, p = unpack_binary_message(pack_binary_message(header, payload))
    assert h == header
    assert p == payload


@pytest.mark.parametrize(
    "payload",
    [b"", b"\x00", bytes([0x00, 0x00, 0x00, 0x01, 0x65]), b"\x00\x00\x01" * 50],
)
def test_round_trip_payload_edge_cases(payload):
    header = {"type": "image_frame", "seq": 1}
    h, p = unpack_binary_message(pack_binary_message(header, payload))
    assert h == header
    assert p == payload


def test_length_prefix_is_little_endian_and_compact_json():
    header = {"type": "image_frame", "seq": 1, "mime": "image/png"}
    packed = pack_binary_message(header, b"x")
    (n,) = struct.unpack("<I", packed[:4])
    header_json = packed[4 : 4 + n].decode("utf-8")
    assert json.loads(header_json) == header
    assert ", " not in header_json and '": ' not in header_json  # compact separators


def test_multibyte_header_length_is_in_bytes():
    header = {"type": "image_frame", "note": "café-🎞"}
    packed = pack_binary_message(header, b"")
    (n,) = struct.unpack("<I", packed[:4])
    # byte length, not character length
    assert n == len(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    h, _ = unpack_binary_message(packed)
    assert h == header


def test_truncated_buffer_raises():
    packed = pack_binary_message({"type": "x"}, b"hello")
    with pytest.raises(ValueError):
        unpack_binary_message(packed[:6])


def test_fixture_generator_round_trips(tmp_path):
    paths = gen_fixtures(tmp_path)
    assert paths
    for json_path in [p for p in paths if p.suffix == ".json"]:
        data = json.loads(json_path.read_text())
        packed = bytes.fromhex(data["packedHex"])
        h, p = unpack_binary_message(packed)
        assert h == data["header"]
        assert p.hex() == data["payloadHex"]
