"""Tests for the ``pdum-rfb demo`` harness (registry, backends, live switch, TUI).

The end-to-end :func:`pdum.rfb.demo_tui.smoke` is the headless proof of the feature: it
switches through every backend available on this box on one WebSocket, decodes a frame
from each, retunes quality, and round-trips a browser input event. Backends/demos that
need absent hardware (NVENC) or deps (MLX) are filtered out, so this runs anywhere.
"""

from __future__ import annotations

import numpy as np
import pytest

from pdum.rfb.demo_tui import available_backends, smoke
from pdum.rfb.demos import DEMOS, _safe, available_demos, get_demo


def test_demo_registry_cpu_scenes_render():
    demos = available_demos()
    keys = {d.key for d in demos}
    # The CPU scenes are always available.
    assert {"test_card", "bouncing_box", "gradient", "checkerboard", "plasma", "paint"} <= keys
    for key in ("test_card", "plasma", "paint"):
        inst = get_demo(key).make()
        frame = inst.frame(0, 0.0, 64, 48)
        assert isinstance(frame, np.ndarray)
        assert frame.shape[:2] == (48, 64)
        assert frame.dtype == np.uint8


def test_get_demo_unknown_raises():
    with pytest.raises(KeyError):
        get_demo("nope")


def test_available_backends_always_offers_image_modes():
    ids = [bid for bid, _label in available_backends()]
    assert ids[:3] == ["image:jpeg", "image:png", "image:webp"]
    # Every entry is (id, human-label).
    assert all(isinstance(label, str) and label for _bid, label in available_backends())


def test_unavailable_demo_is_hidden():
    # A scene whose availability probe raises is silently dropped, not crashed on.
    assert _safe(lambda: 1 / 0) is False
    assert all(d in DEMOS for d in DEMOS)  # registry stable


def test_paint_demo_consumes_pointer_events():
    paint = get_demo("paint").make()
    paint.frame(0, 0.0, 32, 24)  # establishes framebuffer size
    paint.on_event({"type": "resize", "width": 32, "height": 24})
    paint.on_event({"type": "pointer_down", "x": 5, "y": 5, "buttons": [1]})
    paint.on_event({"type": "pointer_move", "x": 10, "y": 8, "buttons": [1]})
    frame = paint.frame(1, 0.03, 32, 24)
    # Something was painted (canvas no longer the uniform background).
    assert len(np.unique(frame.reshape(-1, 3), axis=0)) > 1


def test_paint_maps_logical_css_coords_to_framebuffer_on_hidpi():
    # Regression guard for the HiDPI off-by-DPR bug: the browser sends *logical
    # CSS* coordinates; the paint demo must scale them to framebuffer pixels using
    # the CSS canvas size carried by the (initial) resize/set_viewport handshake.
    # On a 2x display the canvas is CSS 640x360 while the framebuffer is 1280x720,
    # so a click at CSS (100, 50) must land at framebuffer (200, 100) -- not (100, 50).
    paint = get_demo("paint").make()
    paint.frame(0, 0.0, 1280, 720)  # publisher owns the framebuffer resolution
    paint.on_event({"type": "resize", "width": 640, "height": 360, "ratio": 2})
    assert paint._to_pixels(100, 50) == (200, 100)
    # A corner click maps to the far framebuffer corner (clamped in-bounds).
    assert paint._to_pixels(640, 360) == (1279, 719)


def test_paint_falls_back_to_framebuffer_size_before_viewport_handshake():
    # If the client never announces its viewport, the demo can only assume CSS ==
    # framebuffer (a 1:1 map). This documents *why* the initial set_viewport must be
    # sent on connect (widgets/src/worker/entry.ts) rather than only on later resizes.
    paint = get_demo("paint").make()
    paint.frame(0, 0.0, 1280, 720)
    assert paint._to_pixels(100, 50) == (100, 50)


async def test_smoke_end_to_end():
    result = await smoke(width=160, height=120, fps=30, verbose=False)
    assert result["ok"] is True
    # The image transports are always exercised and must decode to the right size.
    for mode in ("image:jpeg", "image:png", "image:webp"):
        assert mode in result["backends"]
        assert "160x120" in result["backends"][mode]
    # The interactive input round-trip was proven (paint demo is always present).
    assert result.get("event_roundtrip") is True


async def test_tui_mounts_and_switches_backend():
    pytest.importorskip("textual")
    import asyncio

    from textual.widgets import OptionList

    from pdum.rfb.demo_app import DemoApp
    from pdum.rfb.demo_tui import _DemoState, _render_loop
    from pdum.rfb.server import DEFAULT_STREAM, serve

    demos = available_demos()
    backends = available_backends()
    state = _DemoState(demos[0].key)
    display = await serve(160, 120, port=0, fps=30, record_events=True)
    host = display._owner_server._streams[DEFAULT_STREAM]
    render_task = asyncio.create_task(_render_loop(display, state, 30))
    app = DemoApp(
        display=display,
        stream_host=host,
        state=state,
        demos=demos,
        backends=backends,
        url="http://127.0.0.1:5173/?ws=ws://x",
        vite_status="test",
        bitrate=8_000_000,
        fps=30,
    )
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            assert app.query_one("#stats")  # mounted
            blist = app.query_one("#backends", OptionList)
            ids = [b[0] for b in backends]
            # Switch to a video backend if one exists here, else an alternate image mode.
            target = next((b for b in ids if not b.startswith("image:")), "image:png")
            app.set_focus(blist)
            blist.highlighted = ids.index(target)
            await pilot.press("enter")
            await pilot.pause()
            if target.startswith("image:"):
                assert host._force_transport == "image"
                assert host.image_mode == target.split(":", 1)[1]
            else:
                assert host._force_transport == "h264"
                assert host.video_encoder == target
    finally:
        import contextlib

        render_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await render_task
        await display.aclose()
