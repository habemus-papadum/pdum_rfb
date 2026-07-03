"""Tests for the anywidget notebook integration (pdum.rfb.notebook).

No browser needed: checks the on-demand bundle wiring, the widget classes/traits, and the
`Display.ws_url` / `Display.widget()` wiring against a real (loopback) server.
"""

import pathlib

import pytest

pytest.importorskip("anywidget")

import pdum.rfb as rfb
from pdum.rfb import notebook
from pdum.rfb.notebook import RfbCanvas, RfbViewer

_STATIC = pathlib.Path(rfb.__file__).parent / "static"
_WIDGET_JS = _STATIC / "widget.js"


@pytest.mark.skipif(
    not _WIDGET_JS.is_file(),
    reason="anywidget bundle not built (on-demand artifact — run pnpm -C widgets build:anywidget)",
)
def test_bundle_artifacts_present() -> None:
    # When built, the bundle must be non-empty and wired as the widget's ESM/CSS. (anywidget
    # wraps the Path `_esm`/`_css` into a FileContents descriptor at class creation, so assert
    # against the module-level resolved values, which are the raw Paths before wrapping.)
    js = _STATIC / "widget.js"
    css = _STATIC / "widget.css"
    assert js.is_file() and js.stat().st_size > 0, "widget.js missing — run pnpm -C widgets build:anywidget"
    assert css.is_file() and css.stat().st_size > 0, "widget.css missing — run pnpm -C widgets build:anywidget"
    assert notebook._ESM == js and notebook._CSS == css


def test_bundle_fallback_when_absent() -> None:
    # The bundle is git-ignored / built on demand, so it may be missing (e.g. a bare `uv sync`,
    # or a `pip install git+…@main`). It must then degrade to a self-explanatory fallback ESM,
    # NOT hand anywidget a non-existent path.
    if _WIDGET_JS.is_file():
        assert notebook._ESM == _WIDGET_JS
    else:
        assert isinstance(notebook._ESM, str)
        assert "widget bundle not found" in notebook._ESM


def test_widget_tiers_default_chrome() -> None:
    viewer = RfbViewer()  # batteries tier: chrome on
    assert viewer.show_toolbar is True
    assert viewer.show_stats is True

    canvas = RfbCanvas()  # bare tier: chrome off
    assert canvas.show_toolbar is False
    assert canvas.show_stats is False
    assert canvas.height == 480  # avoids the 0-height cell -> 320x240 fallback


def test_main_thread_present_default_is_host_aware(monkeypatch) -> None:
    # Outside marimo (the test env), the default is the lower-overhead OffscreenCanvas path,
    # which also carries the backend-switch/zoom chrome — Jupyter shouldn't pay the marimo cost.
    assert RfbCanvas().main_thread_present is False
    assert RfbViewer().main_thread_present is False

    # Under marimo, the default flips to the reparent-safe main-thread draw.
    monkeypatch.setattr(notebook, "_running_in_marimo", lambda: True)
    assert RfbCanvas().main_thread_present is True
    assert RfbViewer().main_thread_present is True

    # An explicit value always wins over the host-aware default.
    monkeypatch.setattr(notebook, "_running_in_marimo", lambda: False)
    assert RfbCanvas(main_thread_present=True).main_thread_present is True
    monkeypatch.setattr(notebook, "_running_in_marimo", lambda: True)
    assert RfbCanvas(main_thread_present=False).main_thread_present is False


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
