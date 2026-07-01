"""Sizing / DPR / color wire contract (docs/proposals/completed/sizing_dpr_color.md).

Covers the additive, opt-in header/config/RawFrame plumbing: the frame render DPR
(`pixel_ratio`), the frame-pixel coordinate contract (`config.coords`), and the color
descriptor. The client-side geometry is unit-tested in widgets/tests/unit/viewport.test.ts.
"""

from __future__ import annotations

import asyncio
import json

import numpy as np
import pytest

from pdum.rfb.display import Display
from pdum.rfb.protocol import config_message, header_for
from pdum.rfb.types import EncodedPayload, RawFrame


class _Clock:
    """A hand-advanced monotonic clock for deterministic debounce tests."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _viewport(w: int, h: int, pw: int, ph: int, ratio: float) -> dict:
    return {"type": "set_viewport", "width": w, "height": h, "pwidth": pw, "pheight": ph, "ratio": ratio}


def _img_payload(**over) -> EncodedPayload:
    kw = dict(seq=0, kind="image", timestamp_us=0, payload=b"x", width=8, height=8, mime="image/jpeg")
    kw.update(over)
    return EncodedPayload(**kw)


# --- pixel_ratio (P2) -------------------------------------------------------


def test_publish_defaults_pixel_ratio_to_one():
    d = Display(8, 8)
    d.publish(np.zeros((8, 8, 3), np.uint8))
    assert d._latest.pixel_ratio == 1.0
    assert d.pixel_ratio == 1.0
    assert d.color is None


def test_publish_carries_pixel_ratio_and_color():
    d = Display(8, 8)
    d.publish(np.zeros((8, 8, 3), np.uint8), pixel_ratio=2.0, color={"primaries": "display-p3"})
    assert d._latest.pixel_ratio == 2.0
    assert d.pixel_ratio == 2.0
    assert d.color == {"primaries": "display-p3"}


def test_publish_keeps_rawframe_pixel_ratio_when_not_overridden():
    d = Display(8, 8)
    f = RawFrame(0, 8, 8, 0, "rgb24", "cpu", np.zeros((8, 8, 3), np.uint8), pixel_ratio=3.0)
    d.publish(f)
    assert d.pixel_ratio == 3.0
    d.publish(f, pixel_ratio=1.5)  # explicit arg wins
    assert d.pixel_ratio == 1.5


def test_header_omits_pixel_ratio_at_default_but_emits_when_set():
    assert "pixel_ratio" not in header_for(_img_payload())  # default 1.0 -> absent (fixtures stay valid)
    h = header_for(_img_payload(pixel_ratio=2.0))
    assert h["pixel_ratio"] == 2.0


def test_header_emits_color_when_present():
    color = {"primaries": "display-p3", "transfer": "srgb", "matrix": "bt709"}
    assert header_for(_img_payload()).get("color") is None
    assert header_for(_img_payload(color=color))["color"] == color


# --- coordinate contract + config (P1/P2/P4) --------------------------------


def test_config_advertises_frame_pixel_coords():
    msg = json.loads(config_message(transport="image", width=640, height=480))
    assert msg["coords"] == "frame-pixels"
    assert "pixel_ratio" not in msg  # omitted at default
    assert "color" not in msg


def test_config_carries_pixel_ratio_and_color_when_set():
    msg = json.loads(
        config_message(
            transport="webcodecs",
            width=1280,
            height=720,
            codec="avc1.42E01F",
            pixel_ratio=2.0,
            color={"primaries": "display-p3"},
        )
    )
    assert msg["pixel_ratio"] == 2.0
    assert msg["color"] == {"primaries": "display-p3"}


# --- match-client resize policy (P3) ----------------------------------------


def test_invalid_resize_policy_raises():
    with pytest.raises(ValueError):
        Display(8, 8, resize_policy="bogus")


def test_publisher_mode_keeps_viewport_informational():
    d = Display(640, 480)  # default "publisher"
    feed = d._make_feed("c1", None)
    asyncio.run(feed.handle_event(_viewport(800, 600, 1600, 1200, 2.0)))
    assert feed.viewport == (1600, 1200, 2.0)  # recorded...
    assert d.target_size is None  # ...but never becomes a render target
    assert d.target_ratio == 1.0


def test_match_client_follows_viewport_debounced():
    clock = _Clock()
    d = Display(640, 480, resize_policy="match_client", resize_debounce=0.12, clock=clock)
    feed = d._make_feed("c1", None)
    asyncio.run(feed.handle_event(_viewport(800, 600, 1600, 1200, 2.0)))
    assert d.target_size is None  # inside the debounce window: not committed yet
    clock.t += 0.2
    assert d.target_size == (1600, 1200)  # settled -> the client backing size
    assert d.target_ratio == 2.0


def test_match_client_clamps_to_max_dimension_and_even_dims():
    clock = _Clock()
    d = Display(640, 480, resize_policy="match_client", max_render_dimension=1000, resize_debounce=0.0, clock=clock)
    d._request_target(1601, 1201, 2.0)  # odd + over the cap
    w, h = d.target_size
    assert max(w, h) <= 1000
    assert w % 2 == 0 and h % 2 == 0  # even for NV12 / H.264
    assert w == 1000 and h == 750  # AR preserved (1201 * 1000/1601 -> 750)


def test_match_client_last_writer_wins_across_viewers():
    clock = _Clock()
    d = Display(640, 480, resize_policy="match_client", resize_debounce=0.0, clock=clock)
    a, b = d._make_feed("a", None), d._make_feed("b", None)
    asyncio.run(a.handle_event(_viewport(400, 300, 400, 300, 1.0)))
    assert d.target_size == (400, 300)
    asyncio.run(b.handle_event(_viewport(800, 600, 800, 600, 1.0)))
    assert d.target_size == (800, 600)  # most recent viewport wins


def test_match_client_publish_at_target_resizes_display():
    # The render loop reads target_size, renders it, and publishes -> the display resizes
    # (the session then rebuilds its fixed-resolution encoder + forces a keyframe).
    clock = _Clock()
    d = Display(640, 480, resize_policy="match_client", resize_debounce=0.0, clock=clock)
    feed = d._make_feed("c1", None)
    asyncio.run(feed.handle_event(_viewport(320, 240, 320, 240, 1.0)))
    w, h = d.target_size
    d.publish(np.zeros((h, w, 3), np.uint8), pixel_ratio=d.target_ratio)
    assert (d.width, d.height) == (320, 240)


# --- color descriptor (P4) --------------------------------------------------


def test_colorspace_presets_and_to_dict():
    from pdum.rfb.types import DISPLAY_P3, SRGB

    assert SRGB.to_dict() == {
        "primaries": "bt709",
        "transfer": "srgb",
        "matrix": "rgb",
        "full_range": True,
        "bit_depth": 8,
    }
    assert DISPLAY_P3.primaries == "display-p3" and DISPLAY_P3.matrix == "bt709"


def test_publish_accepts_colorspace_object():
    from pdum.rfb.types import DISPLAY_P3

    d = Display(8, 8)
    d.publish(np.zeros((8, 8, 3), np.uint8), color=DISPLAY_P3)
    assert d.color == DISPLAY_P3.to_dict()  # normalized to its wire dict


def test_h264_color_vui_mapping():
    from pdum.rfb.encoders.h264_cpu import h264_color_vui
    from pdum.rfb.types import DISPLAY_P3

    assert h264_color_vui(None) is None  # default sRGB -> no VUI (bitstream unchanged)
    # (primaries=SMPTE432, transfer=sRGB, matrix=BT.601 to match our conversion, range=limited)
    assert h264_color_vui(DISPLAY_P3.to_dict()) == (12, 13, 6, 1)


def test_h264_stream_carries_display_p3_vui_end_to_end():
    from pdum.rfb.encoders.h264_cpu import H264CpuEncoder, h264_cpu_available
    from pdum.rfb.testing import decode_annexb
    from pdum.rfb.types import DISPLAY_P3

    if not h264_cpu_available():
        import pytest as _pytest

        _pytest.skip("libx264 not available")

    def encode(color):
        enc = H264CpuEncoder(width=128, height=96, fps=8, color=color)
        chunks: list[bytes] = []
        for s in range(8):
            arr = np.full((96, 128, 3), (s * 20) % 256, np.uint8)
            frame = RawFrame(s, 128, 96, s * 1000, "rgb24", "cpu", arr)
            chunks += [p.payload for p in enc.encode(frame, force_keyframe=(s == 0))]
        chunks += [p.payload for p in enc.flush()]
        enc.close()
        return decode_annexb(b"".join(chunks))

    p3 = encode(DISPLAY_P3.to_dict())[0]
    assert int(p3.color_primaries) == 12  # SMPTE432 / Display P3 signaled in the VUI
    default = encode(None)[0]
    assert int(default.color_primaries) == 2  # unspecified -> no VUI written (sRGB stream unchanged)
