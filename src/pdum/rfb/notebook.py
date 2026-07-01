"""anywidget (Jupyter + marimo) front-end for ``pdum.rfb``.

Optional — install the extra::

    uv add 'habemus-papadum-rfb[anywidget]'

The widget loads a single self-contained ESM bundle (the Web Worker is inlined) that drives
the same ``RemoteFramebufferView`` as the standalone browser client. Frames travel over a
plain WebSocket, **not** the Jupyter/ipywidgets kernel comm — so the notebook only carries
the ``url``/``token`` traits, never pixels.

**One widget = one Web Worker + one WebSocket.** The Python ``Server`` hub multiplexes many
streams on one port, so N cells = N widgets = N independent streams (see
``docs/notebook.md``). Typical use::

    import pdum.rfb as rfb
    from pdum.rfb.notebook import publish_loop

    display = await rfb.serve(1280, 720, port=0)     # top-level await; loop already running
    task = publish_loop(display, lambda: render(), fps=30)   # non-blocking background task
    display.widget()                                  # -> batteries viewer in the cell
"""

from __future__ import annotations

import asyncio
import pathlib
from typing import TYPE_CHECKING, Any, Callable

try:
    import anywidget
    import traitlets
except ModuleNotFoundError as exc:  # pragma: no cover - only hit when the extra is absent
    raise ModuleNotFoundError(
        "pdum.rfb.notebook needs the 'anywidget' extra:  uv add 'habemus-papadum-rfb[anywidget]'"
    ) from exc

if TYPE_CHECKING:  # pragma: no cover
    from .display import Display

_STATIC = pathlib.Path(__file__).parent / "static"


class RfbCanvas(anywidget.AnyWidget):
    """Bare tier: just the framebuffer canvas filling the cell — you supply the chrome/CSS.

    Connection traits (``url``/``host``/``base_path``/``port``/``stream``/``token``/
    ``image_only``) are connect-time: mutating one rebuilds the view. ``height`` sizes the
    output (a notebook output ``<div>`` is 0-height by default, so the canvas would fall
    back to 320×240 without it). ``state``/``stats``/``last_error`` are read back from JS.
    """

    _esm = _STATIC / "widget.js"
    _css = _STATIC / "widget.css"

    # --- connection (connect-time) ---
    url = traitlets.Unicode("").tag(sync=True)  # explicit override; wins over host/port
    host = traitlets.Unicode("auto").tag(sync=True)  # "auto" -> the browser's location.hostname
    base_path = traitlets.Unicode("").tag(sync=True)  # set for same-origin (remote/HTTPS) wss
    port = traitlets.Int(0).tag(sync=True)
    stream = traitlets.Unicode("default").tag(sync=True)
    token = traitlets.Unicode("").tag(sync=True)
    image_only = traitlets.Bool(False).tag(sync=True)
    # Fit mode when the frame AR differs from the canvas AR ("contain" | "cover" | "fill";
    # default "contain" client-side); background is the letterbox fill for "contain".
    fit = traitlets.Unicode("").tag(sync=True)
    background = traitlets.Unicode("").tag(sync=True)
    height = traitlets.Int(480).tag(sync=True)

    # --- chrome (off in the bare tier) ---
    show_toolbar = traitlets.Bool(False).tag(sync=True)
    show_stats = traitlets.Bool(False).tag(sync=True)

    # --- readback (JS -> Python; observable) ---
    state = traitlets.Unicode("connecting").tag(sync=True)
    stats = traitlets.Dict().tag(sync=True)
    last_error = traitlets.Unicode("").tag(sync=True)


class RfbViewer(RfbCanvas):
    """Batteries tier: status pill + latency badge + toggleable stats HUD + toolbar.

    Same connection traits as :class:`RfbCanvas`, with the chrome on by default. Theme via
    the CSS custom properties on ``.rfb-root`` (a cell-injected ``<style>`` or a JupyterLab
    theme); drop chrome per-widget with ``show_toolbar=False`` / ``show_stats=False``.
    """

    show_toolbar = traitlets.Bool(True).tag(sync=True)
    show_stats = traitlets.Bool(True).tag(sync=True)


def publish_loop(display: "Display", render: Callable[[], Any], *, fps: int = 30) -> "asyncio.Task[None]":
    """Schedule ``render()`` → ``display.publish()`` as a background task; return it immediately.

    Non-blocking, so a notebook cell keeps going while frames flow (Jupyter/marimo already
    run an asyncio loop, and ``await rfb.serve(...)`` works with top-level await). Tear down
    with ``task.cancel()`` then ``await display.aclose()``. To handle input, poll
    ``display.poll_events()`` from inside ``render`` or run your own loop instead; the event
    queue is bounded, so leaving it unpolled is safe.
    """
    period = 1.0 / fps

    async def _run() -> None:
        try:
            while not display._closed:
                display.publish(render())
                await asyncio.sleep(period)
        except asyncio.CancelledError:  # graceful stop on task.cancel()
            pass

    return asyncio.ensure_future(_run())
