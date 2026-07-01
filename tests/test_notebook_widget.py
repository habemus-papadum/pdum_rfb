"""Tests for the anywidget notebook integration (pdum.rfb.notebook).

No browser needed: checks the committed bundle ships, the widget classes/traits, and the
`Display.ws_url` / `Display.widget()` wiring against a real (loopback) server.
"""

import pathlib

import pytest

pytest.importorskip("anywidget")

import pdum.rfb as rfb
from pdum.rfb.notebook import RfbCanvas, RfbViewer

_STATIC = pathlib.Path(rfb.__file__).parent / "static"


def test_bundle_artifacts_present() -> None:
    # The committed, prebuilt bundle must exist (this is also the build-artifact gate).
    js = _STATIC / "widget.js"
    css = _STATIC / "widget.css"
    assert js.is_file() and js.stat().st_size > 0, "widget.js missing — run pnpm -C widgets build:anywidget"
    assert css.is_file() and css.stat().st_size > 0, "widget.css missing — run pnpm -C widgets build:anywidget"


def test_widget_tiers_default_chrome() -> None:
    viewer = RfbViewer()  # batteries tier: chrome on
    assert viewer.show_toolbar is True
    assert viewer.show_stats is True

    canvas = RfbCanvas()  # bare tier: chrome off
    assert canvas.show_toolbar is False
    assert canvas.show_stats is False
    assert canvas.height == 480  # avoids the 0-height cell -> 320x240 fallback


async def test_ws_url_and_widget_factory() -> None:
    display = await rfb.serve(64, 64, port=0)
    try:
        assert display.ws_url == f"ws://127.0.0.1:{display.port}/default"

        w = display.widget()
        assert isinstance(w, RfbViewer)
        assert w.port == display.port
        assert w.stream == "default"
        assert w.host == "127.0.0.1"
        assert w.show_toolbar is True

        bare = display.widget(batteries=False, show_stats=False)
        assert isinstance(bare, RfbCanvas) and not isinstance(bare, RfbViewer)
        assert bare.show_toolbar is False

        remote = display.widget(base_path="/proxy/rfb")
        assert remote.base_path == "/proxy/rfb"
    finally:
        await display.aclose()


async def test_widget_on_named_stream() -> None:
    server = await rfb.serve_server(port=0)
    try:
        cam = server.add_stream("camera", 64, 64)
        w = cam.widget()
        assert w.stream == "camera"
        assert cam.ws_url.endswith("/camera")
    finally:
        await server.aclose()
