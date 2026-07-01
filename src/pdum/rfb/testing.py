"""Test and demo helpers (omitted from coverage on purpose).

Contains the headless-rendering :class:`SyntheticFrameSource`, in-memory fakes
for driving the session without real sockets/encoders, Annex B / NAL helpers for
validating H.264 output, and a fixture generator that keeps the JavaScript wire
protocol byte-compatible with the Python one.

The :func:`render_test_pattern` formula is the *shared contract* re-implemented
in ``widgets/tests`` so the browser e2e can verify decoded pixels against a
locally computed expectation.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from typing import Callable, Literal

import numpy as np

from .protocol import pack_binary_message
from .sources import BaseFrameSource, _make_even
from .types import EncodedPayload, RawFrame

Pattern = Literal["test_card", "gradient", "bouncing_box", "counter", "checkerboard", "solid"]

# Four flat quadrant colors (R, G, B, Y). Large flat regions keep the decoded
# result within tolerance under lossy JPEG / H.264.
_QUADRANT_COLORS = np.array(
    [[220, 40, 40], [40, 200, 40], [40, 40, 220], [220, 200, 40]],
    dtype=np.uint8,
)


def render_test_pattern(seq: int, width: int, height: int) -> np.ndarray:
    """Canonical deterministic RGB test pattern (shared with the JS e2e tests).

    Four quadrants, each a flat color that cycles by ``seq`` so consecutive
    frames differ (exercising inter-frame compression) while interior pixels
    stay flat (robust to lossy decoding). The browser test recomputes the
    expected quadrant colors for the displayed ``seq`` and compares.
    """
    arr = np.empty((height, width, 3), dtype=np.uint8)
    hw, hh = width // 2, height // 2
    quadrants = [(0, hh, 0, hw), (0, hh, hw, width), (hh, height, 0, hw), (hh, height, hw, width)]
    for q, (y0, y1, x0, x1) in enumerate(quadrants):
        arr[y0:y1, x0:x1] = _QUADRANT_COLORS[(q + seq) % 4]
    return arr


def expected_quadrant_color(seq: int, quadrant: int) -> tuple[int, int, int]:
    """Return the expected RGB color of ``quadrant`` (0..3) at frame ``seq``."""
    r, g, b = _QUADRANT_COLORS[(quadrant + seq) % 4]
    return (int(r), int(g), int(b))


def _render_gradient(seq: int, width: int, height: int) -> np.ndarray:
    xs = (np.arange(width, dtype=np.uint16) + seq * 4) % 256
    row = np.empty((width, 3), dtype=np.uint8)
    row[:, 0] = xs
    row[:, 1] = 255 - xs
    row[:, 2] = (seq * 2) % 256
    return np.broadcast_to(row, (height, width, 3)).copy()


def _render_bouncing_box(seq: int, width: int, height: int) -> np.ndarray:
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    arr[:] = (16, 16, 24)
    bw, bh = max(8, width // 8), max(8, height // 8)
    span_x = max(1, width - bw)
    span_y = max(1, height - bh)
    x = _triangle(seq * 7, span_x)
    y = _triangle(seq * 5, span_y)
    arr[y : y + bh, x : x + bw] = (240, 80, 40)
    return arr


def _render_counter(seq: int, width: int, height: int) -> np.ndarray:
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    cell = max(4, width // 32)
    for bit in range(min(32, width // cell)):
        if (seq >> bit) & 1:
            arr[0:cell, bit * cell : (bit + 1) * cell] = (255, 255, 255)
    arr[cell:, :] = ((seq * 3) % 256, (seq * 5) % 256, (seq * 7) % 256)
    return arr


def _render_checkerboard(seq: int, width: int, height: int) -> np.ndarray:
    yy, xx = np.mgrid[0:height, 0:width]
    cell = 16
    mask = (((xx + seq) // cell) + (yy // cell)) % 2
    arr = np.where(mask[..., None] == 0, (20, 20, 20), (235, 235, 235)).astype(np.uint8)
    return arr


def _render_solid(seq: int, width: int, height: int) -> np.ndarray:
    color = _QUADRANT_COLORS[seq % 4]
    return np.broadcast_to(color, (height, width, 3)).copy()


_PATTERNS: dict[str, Callable[[int, int, int], np.ndarray]] = {
    "test_card": render_test_pattern,
    "gradient": _render_gradient,
    "bouncing_box": _render_bouncing_box,
    "counter": _render_counter,
    "checkerboard": _render_checkerboard,
    "solid": _render_solid,
}


def render_pattern(name: str, seq: int, width: int, height: int) -> np.ndarray:
    """Render any named pattern (used by the benchmark harness)."""
    if name not in _PATTERNS:
        raise ValueError(f"unknown pattern {name!r}; choose from {sorted(_PATTERNS)}")
    return _PATTERNS[name](seq, width, height)


def _triangle(t: int, span: int) -> int:
    """A bouncing 0..span..0 position for integer time ``t``."""
    period = 2 * span
    p = t % period
    return p if p <= span else period - p


class SyntheticFrameSource(BaseFrameSource):
    """Deterministic, GUI-free frame source for tests and the demo server."""

    def __init__(self, *, pattern: Pattern = "test_card", **kwargs) -> None:
        super().__init__(**kwargs)
        if pattern not in _PATTERNS:
            raise ValueError(f"unknown pattern {pattern!r}; choose from {sorted(_PATTERNS)}")
        self.pattern = pattern
        self._renderer = _PATTERNS[pattern]
        if self.pixel_format not in ("rgb24", "rgba8"):
            raise ValueError("SyntheticFrameSource supports rgb24 / rgba8 only")

    def render(self, seq: int, t_us: int) -> np.ndarray:
        rgb = self._renderer(seq, self.width, self.height)
        if self.pixel_format == "rgba8":
            rgba = np.empty((self.height, self.width, 4), dtype=np.uint8)
            rgba[..., :3] = rgb
            rgba[..., 3] = 255
            return np.ascontiguousarray(rgba)
        return np.ascontiguousarray(rgb)


class FakeEncoder:
    """A deterministic in-memory encoder for session tests (no PyAV needed)."""

    def __init__(self, *, kind: str = "video", keyframe_interval: int = 30, **_: object) -> None:
        self.kind = kind
        self.keyframe_interval = keyframe_interval
        self.calls = 0

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        is_key = force_keyframe or (self.calls % self.keyframe_interval == 0)
        self.calls += 1
        payload = f"frame:{frame.seq}:{'key' if is_key else 'delta'}".encode()
        return [
            EncodedPayload(
                seq=frame.seq,
                kind=self.kind,  # type: ignore[arg-type]
                timestamp_us=frame.timestamp_us,
                width=frame.width,
                height=frame.height,
                payload=payload,
                codec="avc1.42E01F" if self.kind == "video" else None,
                keyframe=is_key,
                metadata={"bitstream": "annexb"} if self.kind == "video" else None,
            )
        ]

    def encode_still(self, frame: RawFrame) -> list[EncodedPayload]:
        """A distinguishable 'still' payload for "still after settle" tests."""
        self.calls += 1
        return [
            EncodedPayload(
                seq=frame.seq,
                kind=self.kind,  # type: ignore[arg-type]
                timestamp_us=frame.timestamp_us,
                width=frame.width,
                height=frame.height,
                payload=f"still:{frame.seq}".encode(),
                codec="avc1.42E01F" if self.kind == "video" else None,
                keyframe=True,
                metadata={"bitstream": "annexb"} if self.kind == "video" else None,
            )
        ]

    def flush(self) -> list[EncodedPayload]:
        return []

    def close(self) -> None:
        pass


class FakeWebSocket:
    """In-memory duplex stand-in for a websockets connection.

    ``sent`` collects every outbound message. Inbound messages are queued via
    :meth:`inject` and yielded by async iteration until :meth:`close`.
    """

    def __init__(self) -> None:
        self.sent: list[bytes | str] = []
        self._inbound: asyncio.Queue[bytes | str] = asyncio.Queue()
        self._closed = False
        self.on_send: Callable[[bytes | str], None] | None = None

    async def send(self, data: bytes | str) -> None:
        self.sent.append(data)
        if self.on_send is not None:
            self.on_send(data)

    def inject(self, message: bytes | str | dict) -> None:
        if isinstance(message, dict):
            message = json.dumps(message)
        self._inbound.put_nowait(message)

    def close(self) -> None:
        self._closed = True
        # Wake a pending __anext__.
        self._inbound.put_nowait(_SENTINEL)

    def __aiter__(self) -> "FakeWebSocket":
        return self

    async def __anext__(self) -> bytes | str:
        if self._closed and self._inbound.empty():
            raise StopAsyncIteration
        item = await self._inbound.get()
        if item is _SENTINEL:
            raise StopAsyncIteration
        return item


_SENTINEL = object()


# --- Annex B / NAL helpers --------------------------------------------------


def parse_nal_units(annexb: bytes) -> list[tuple[int, bytes]]:
    """Split an Annex B byte stream into ``(nal_type, body)`` tuples."""
    units: list[tuple[int, bytes]] = []
    data = bytes(annexb)
    starts: list[int] = []
    i = 0
    n = len(data)
    while i < n - 3:
        if data[i] == 0 and data[i + 1] == 0:
            if data[i + 2] == 1:
                starts.append((i, 3))
                i += 3
                continue
            if data[i + 2] == 0 and i < n - 4 and data[i + 3] == 1:
                starts.append((i, 4))
                i += 4
                continue
        i += 1
    for idx, (pos, sc_len) in enumerate(starts):
        body_start = pos + sc_len
        body_end = starts[idx + 1][0] if idx + 1 < len(starts) else n
        body = data[body_start:body_end]
        if body:
            nal_type = body[0] & 0x1F
            units.append((nal_type, body))
    return units


def nal_types(annexb: bytes) -> set[int]:
    """Return the set of NAL unit types present in an Annex B stream."""
    return {t for t, _ in parse_nal_units(annexb)}


def has_sps_pps_idr(annexb: bytes) -> bool:
    """True if the stream contains SPS (7), PPS (8) and an IDR slice (5)."""
    types = nal_types(annexb)
    return {7, 8, 5}.issubset(types)


def starts_with_start_code(data: bytes) -> bool:
    """True if ``data`` begins with an Annex B start code (not AVCC length)."""
    return data[:4] == b"\x00\x00\x00\x01" or data[:3] == b"\x00\x00\x01"


class _BitReader:
    """Minimal MSB-first bit reader with Exp-Golomb decoding for SPS parsing."""

    def __init__(self, data: bytes):
        self._d = data
        self._p = 0

    def u1(self) -> int:
        bit = (self._d[self._p >> 3] >> (7 - (self._p & 7))) & 1
        self._p += 1
        return bit

    def u(self, n: int) -> int:
        v = 0
        for _ in range(n):
            v = (v << 1) | self.u1()
        return v

    def ue(self) -> int:
        zeros = 0
        while self.u1() == 0:
            zeros += 1
            if zeros > 40:
                raise ValueError("Exp-Golomb runaway (malformed SPS?)")
        return (1 << zeros) - 1 + (self.u(zeros) if zeros else 0)

    def se(self) -> int:
        k = self.ue()
        return (k + 1) // 2 if k & 1 else -(k // 2)


def _unescape_rbsp(rbsp: bytes) -> bytes:
    """Strip emulation-prevention bytes (00 00 03 -> 00 00) from a NAL body."""
    out = bytearray()
    i = 0
    while i < len(rbsp):
        if i + 2 < len(rbsp) and rbsp[i] == 0 and rbsp[i + 1] == 0 and rbsp[i + 2] == 3:
            out += rbsp[i : i + 2]
            i += 3
        else:
            out.append(rbsp[i])
            i += 1
    return bytes(out)


def h264_sps_reorder_info(annexb: bytes) -> dict:
    """Parse the SPS of an Annex B stream and return its reorder-relevant fields.

    Keys: ``profile_idc``, ``level_idc``, ``vui_present``, ``bitstream_restriction_flag``,
    ``max_num_reorder_frames`` (``None`` unless the restriction is present),
    ``max_dec_frame_buffering``.

    Why this matters: a WebCodecs **hardware** ``VideoDecoder`` that does not see
    ``max_num_reorder_frames=0`` assumes worst-case reordering and buffers up to the level's
    DPB size before its first output. Under the session's small ``max_inflight`` that starves
    and the canvas silently freezes (no error). So the encoder must signal zero reordering.
    """
    sps = next((body for t, body in parse_nal_units(annexb) if t == 7), None)
    if sps is None:
        raise ValueError("no SPS (NAL type 7) in stream")
    b = _BitReader(_unescape_rbsp(sps[1:]))  # drop the NAL header byte
    profile_idc = b.u(8)
    b.u(8)  # constraint_set flags + reserved
    level_idc = b.u(8)
    b.ue()  # seq_parameter_set_id
    if profile_idc in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
        if b.ue() == 3:  # chroma_format_idc
            b.u1()  # separate_colour_plane
        b.ue()  # bit_depth_luma_minus8
        b.ue()  # bit_depth_chroma_minus8
        b.u1()  # qpprime_y_zero_transform_bypass
        if b.u1():  # seq_scaling_matrix_present (not emitted by baseline/main/high here)
            raise ValueError("scaling matrix present; parser not needed for this path")
    b.ue()  # log2_max_frame_num_minus4
    poc_type = b.ue()
    if poc_type == 0:
        b.ue()  # log2_max_pic_order_cnt_lsb_minus4
    elif poc_type == 1:
        b.u1()
        b.se()
        b.se()
        for _ in range(b.ue()):
            b.se()
    b.ue()  # max_num_ref_frames
    b.u1()  # gaps_in_frame_num_value_allowed
    b.ue()  # pic_width_in_mbs_minus1
    b.ue()  # pic_height_in_map_units_minus1
    if not b.u1():  # frame_mbs_only_flag
        b.u1()  # mb_adaptive_frame_field
    b.u1()  # direct_8x8_inference
    if b.u1():  # frame_cropping
        b.ue()
        b.ue()
        b.ue()
        b.ue()
    info = {
        "profile_idc": profile_idc,
        "level_idc": level_idc,
        "vui_present": bool(b.u1()),
        "bitstream_restriction_flag": None,
        "max_num_reorder_frames": None,
        "max_dec_frame_buffering": None,
    }
    if not info["vui_present"]:
        return info
    if b.u1() and b.u(8) == 255:  # aspect_ratio_info_present, Extended_SAR
        b.u(16)
        b.u(16)
    if b.u1():  # overscan_info_present
        b.u1()
    if b.u1():  # video_signal_type_present
        b.u(3)
        b.u1()
        if b.u1():  # colour_description_present
            b.u(24)
    if b.u1():  # chroma_loc_info_present
        b.ue()
        b.ue()
    if b.u1():  # timing_info_present
        b.u(32)
        b.u(32)
        b.u1()
    nal_hrd = b.u1()
    if nal_hrd:
        _skip_hrd(b)
    vcl_hrd = b.u1()
    if vcl_hrd:
        _skip_hrd(b)
    if nal_hrd or vcl_hrd:
        b.u1()  # low_delay_hrd
    b.u1()  # pic_struct_present
    if b.u1():  # bitstream_restriction_flag
        info["bitstream_restriction_flag"] = True
        b.u1()  # motion_vectors_over_pic_boundaries
        b.ue()  # max_bytes_per_pic_denom
        b.ue()  # max_bits_per_mb_denom
        b.ue()  # log2_max_mv_length_horizontal
        b.ue()  # log2_max_mv_length_vertical
        info["max_num_reorder_frames"] = b.ue()
        info["max_dec_frame_buffering"] = b.ue()
    else:
        info["bitstream_restriction_flag"] = False
    return info


def _skip_hrd(b: _BitReader) -> None:
    cpb_cnt = b.ue() + 1
    b.u(4)  # bit_rate_scale
    b.u(4)  # cpb_size_scale
    for _ in range(cpb_cnt):
        b.ue()  # bit_rate_value_minus1
        b.ue()  # cpb_size_value_minus1
        b.u1()  # cbr_flag
    b.u(20)  # 4x 5-bit HRD delay-length fields


def decode_annexb(data: bytes) -> list:
    """Decode an H.264 Annex B byte stream back to frames using PyAV.

    Returns a list of ``av.VideoFrame``. Used by the headless encoder tests to
    prove the produced bitstream is valid and decodable without a browser.
    """
    import av  # lazy: only needed when validating H.264 output

    frames = []
    codec = av.CodecContext.create("h264", "r")
    packets = codec.parse(data)
    for packet in packets:
        frames.extend(codec.decode(packet))
    frames.extend(codec.decode(None))  # flush
    return frames


# --- Loopback server + fixture generation -----------------------------------


@contextlib.asynccontextmanager
async def loopback_server(handler, *, host: str = "127.0.0.1", port: int = 0):
    """Run a real ``websockets`` server for one integration test.

    Yields ``(host, port)`` of the listening server; the OS assigns a free port
    when ``port`` is 0.
    """
    import websockets.asyncio.server

    async with websockets.asyncio.server.serve(handler, host, port) as server:
        sock = next(iter(server.sockets))
        bound_host, bound_port = sock.getsockname()[:2]
        yield bound_host, bound_port


def gen_fixtures(out_dir: str | Path) -> list[Path]:
    """Generate protocol parity fixtures for the JavaScript test suite.

    Writes ``<name>.bin`` (the packed binary message) and ``<name>.json``
    (the expected header + payload hex) for a few canonical messages.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    cases: list[tuple[str, dict, bytes]] = [
        (
            "image_jpeg",
            {
                "type": "image_frame",
                "seq": 42,
                "timestamp_us": 700000,
                "width": 1280,
                "height": 720,
                "mime": "image/jpeg",
            },
            bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]),
        ),
        (
            "video_annexb",
            {
                "type": "video_chunk",
                "seq": 7,
                "timestamp_us": 16666,
                "width": 640,
                "height": 480,
                "codec": "avc1.42E01F",
                "bitstream": "annexb",
                "keyframe": True,
            },
            bytes([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]),
        ),
        (
            "unicode_header",
            {"type": "image_frame", "seq": 1, "note": "café-🎞", "width": 2, "height": 2},
            bytes([1, 2, 3]),
        ),
    ]

    written: list[Path] = []
    for name, header, payload in cases:
        packed = pack_binary_message(header, payload)
        bin_path = out / f"{name}.bin"
        json_path = out / f"{name}.json"
        bin_path.write_bytes(packed)
        json_path.write_text(
            json.dumps(
                {"header": header, "payloadHex": payload.hex(), "packedHex": packed.hex()},
                indent=2,
            )
        )
        written.extend([bin_path, json_path])
    return written


__all__ = [
    "FakeEncoder",
    "FakeWebSocket",
    "Pattern",
    "SyntheticFrameSource",
    "decode_annexb",
    "expected_quadrant_color",
    "gen_fixtures",
    "h264_sps_reorder_info",
    "has_sps_pps_idr",
    "loopback_server",
    "nal_types",
    "parse_nal_units",
    "render_pattern",
    "render_test_pattern",
    "starts_with_start_code",
    "_make_even",  # re-exported for convenience in tests
]


# Allow `python -m pdum.rfb.testing <out_dir>` to (re)generate JS fixtures.
if __name__ == "__main__":  # pragma: no cover
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "widgets/tests/fixtures/protocol"
    paths = gen_fixtures(target)
    print(f"wrote {len(paths)} fixture files to {target}")
    for p in paths:
        print(f"  {p}")
