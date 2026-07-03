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
_WIDGET_JS = _STATIC / "widget.js"
_WIDGET_CSS = _STATIC / "widget.css"

# The anywidget ESM bundle (widget.js) is a BUILD ARTIFACT and is NOT committed to git — like
# the ``pdum-rfb demo`` SPA, it's built on demand (``pnpm -C widgets build:anywidget``; setup.sh
# runs it in a dev checkout, and the release CI runs it before packaging so every PyPI wheel
# ships it). A source tree that never ran that build has no bundle, and anywidget would raise on
# a missing ``_esm`` path. So when it's absent we hand anywidget a tiny fallback ESM that renders
# a self-explanatory cell — telling the two audiences apart, because their fix differs:
#   * a dev checkout of the repo can just build it;
#   * a ``pip install git+…@main`` install can't (nothing built the JS), and the widget isn't
#     supported from git main today — the released PyPI package is the supported path.
_MISSING_BUNDLE_ESM = r"""
export function render({ el }) {
  el.innerHTML = `
  <div style="font:13px/1.55 system-ui,-apple-system,sans-serif;max-width:660px;
              padding:16px 18px;border:1px solid #e0b400;border-radius:8px;
              background:#fffbea;color:#333">
    <div style="font-weight:600;color:#8a6d00;margin-bottom:.5em">
      pdum.rfb widget bundle not found
    </div>
    <p style="margin:.5em 0">
      The anywidget JavaScript bundle (<code>pdum/rfb/static/widget.js</code>) isn't present.
      It is a <strong>build artifact that is not committed to git</strong> — it's built on
      demand — so this particular install never produced it.
    </p>
    <p style="margin:.9em 0 .3em">
      <strong>If you're in a checkout of the repo</strong>, build it once and restart the kernel:
    </p>
    <pre style="margin:.2em 0;padding:8px 10px;background:#00000010;border-radius:6px;
                overflow:auto;font:12px/1.4 ui-monospace,Menlo,monospace">
./scripts/setup.sh          # or, just the bundle:
pnpm -C widgets build:anywidget</pre>
    <p style="margin:.9em 0 .3em">
      <strong>If you installed straight from git main</strong>
      (e.g. <code>pip install "habemus-papadum-rfb[anywidget] @ git+…@main"</code>):
      the widget is <strong>not supported that way</strong>. Installing from git main doesn't
      build the on-demand JavaScript, so the widget can't work from that install. Use the
      released package instead —
      <code>pip install "habemus-papadum-rfb[anywidget]"</code> from PyPI always ships the
      bundle. If you specifically need the widget from git main, please
      <strong>open an issue</strong>: we don't support it today, but we can add it back if
      there's enough demand.
    </p>
  </div>`;
}
"""

# Path → anywidget reads & (in dev) watches the real bundle; str → it treats the value as the
# literal ESM/CSS. Resolve which at import time.
if _WIDGET_JS.is_file():
    _ESM: Any = _WIDGET_JS
    _CSS: Any = _WIDGET_CSS
else:
    _ESM = _MISSING_BUNDLE_ESM
    _CSS = ""


class RfbCanvas(anywidget.AnyWidget):
    """Bare tier: just the framebuffer canvas filling the cell — you supply the chrome/CSS.

    Connection traits (``url``/``host``/``base_path``/``port``/``stream``/``token``/
    ``image_only``/``main_thread_present``) are connect-time: mutating one rebuilds the view.
    ``main_thread_present`` (default ``True``) draws frames on the main thread so the widget
    survives host reparenting (marimo); set ``False`` for the OffscreenCanvas transfer path.
    ``height`` sizes the
    output (a notebook output ``<div>`` is 0-height by default, so the canvas would fall
    back to 320×240 without it). ``state``/``stats``/``last_error`` are read back from JS.
    """

    _esm = _ESM
    _css = _CSS

    # --- connection (connect-time) ---
    url = traitlets.Unicode("").tag(sync=True)  # explicit override; wins over host/port
    host = traitlets.Unicode("auto").tag(sync=True)  # "auto" -> the browser's location.hostname
    base_path = traitlets.Unicode("").tag(sync=True)  # set for same-origin (remote/HTTPS) wss
    port = traitlets.Int(0).tag(sync=True)
    stream = traitlets.Unicode("default").tag(sync=True)
    token = traitlets.Unicode("").tag(sync=True)
    image_only = traitlets.Bool(False).tag(sync=True)
    # Present path. True (default): draw each frame on the MAIN THREAD (a normal <canvas> the
    # framework may freely reparent) — robust in every embedding host, including marimo, which
    # reparents the widget subtree and blanks the OffscreenCanvas-transfer path. False: transfer
    # an OffscreenCanvas to the worker (slightly lower overhead) where the host won't reparent.
    main_thread_present = traitlets.Bool(True).tag(sync=True)
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
