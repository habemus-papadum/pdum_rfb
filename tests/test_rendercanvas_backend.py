"""Tests for the optional rendercanvas backend (``pdum.rfb.rendercanvas``).

Skipped unless the ``rendercanvas`` extra is installed. These cover the *bridge* we own
— present→publish, the renderview→rendercanvas event key-rename, and lifecycle — using a
bare :class:`~pdum.rfb.display.Display` (no server, no GPU). The full pygfx-on-wgpu render
round-trip needs a GPU/adapter and is exercised manually, not here.
"""

import numpy as np
import pytest

pytest.importorskip("rendercanvas")

from pdum.rfb.display import Display  # noqa: E402
from pdum.rfb.rendercanvas import RfbRenderCanvas, _to_rendercanvas_event  # noqa: E402


def _canvas(width=64, height=64):
    display = Display(width, height)
    return RfbRenderCanvas(display=display, size=(width, height)), display


def test_to_rendercanvas_event_renames_keys():
    out = _to_rendercanvas_event(
        {
            "type": "pointer_down",
            "x": 10,
            "y": 20,
            "button": 1,
            "buttons": [1],
            "modifiers": ["Shift"],
            "timestamp": 1.5,
        }
    )
    assert out == {
        "event_type": "pointer_down",
        "x": 10,
        "y": 20,
        "button": 1,
        "buttons": [1],
        "modifiers": ["Shift"],
        "time_stamp": 1.5,
    }
    assert "type" not in out and "timestamp" not in out


def test_to_rendercanvas_event_skips_non_forwarded():
    assert _to_rendercanvas_event({"type": "resize", "width": 800, "height": 600}) is None
    assert _to_rendercanvas_event({"type": "set_viewport", "width": 800, "height": 600}) is None


def test_present_info_bitmap_only():
    canvas, _ = _canvas()
    assert canvas._rc_get_present_info(["bitmap"]) == {"method": "bitmap", "formats": ["rgba-u8"]}
    assert canvas._rc_get_present_info(["screen"]) is None


def test_present_bitmap_publishes_to_display():
    canvas, display = _canvas(64, 48)
    frame = np.full((48, 64, 4), 200, dtype=np.uint8)
    canvas._rc_present_bitmap(data=frame, format="rgba-u8")
    assert display._latest is not None
    assert (display._latest.width, display._latest.height) == (64, 48)
    assert display._latest.pixel_format == "rgba8"


def test_gui_poll_translates_and_delivers_events():
    canvas, display = _canvas()
    received = []
    canvas.add_event_handler(received.append, "pointer_down", "wheel")

    display._enqueue_event(
        "c1",
        None,
        {"type": "pointer_down", "x": 1, "y": 2, "button": 1, "buttons": [1], "modifiers": [], "timestamp": 0.5},
    )
    display._enqueue_event("c1", None, {"type": "resize", "width": 800, "height": 600})  # must be dropped
    display._enqueue_event(
        "c1", None, {"type": "wheel", "x": 1, "y": 2, "dx": 0, "dy": -120, "buttons": [], "modifiers": []}
    )

    canvas._rc_gui_poll()  # drains the display queue and submits to the canvas
    canvas._events.flush()  # dispatch to handlers

    kinds = [e["event_type"] for e in received]
    assert kinds == ["pointer_down", "wheel"]  # resize was not forwarded
    assert received[0]["x"] == 1 and received[0]["button"] == 1
    assert received[0]["time_stamp"] == 0.5
    assert display.poll_events() == []  # the backend drained the queue


def test_close_stops_publishing():
    canvas, display = _canvas()
    canvas._rc_close()
    assert canvas._rc_get_closed() is True
    canvas._rc_present_bitmap(data=np.zeros((64, 64, 4), np.uint8), format="rgba-u8")
    assert display._latest is None  # nothing published after close
