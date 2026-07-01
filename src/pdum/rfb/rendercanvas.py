"""A `rendercanvas <https://rendercanvas.readthedocs.io>`_ backend that streams over ``pdum.rfb``.

``rendercanvas`` is the canvas-abstraction layer under ``wgpu`` / ``pygfx`` /
``fastplotlib``: a render engine targets an abstract canvas and a *backend* decides where
the pixels go (a glfw window, a Qt widget, an offscreen buffer, a notebook...). This
module is a backend whose pixels go to a :class:`pdum.rfb.Display` — i.e. a ``wgpu``/
``pygfx`` app renders unchanged and the result streams to the browser over this library's
WebSocket + Web-Worker pipeline (image or H.264/WebCodecs), with input flowing back.

It is the spiritual equivalent of ``rendercanvas``'s own ``jupyter_rfb`` backend, but on
this library's transport. **Cross-platform**: the ``"bitmap"`` present method downloads
the rendered frame to a host ``numpy`` array, so it works identically on macOS and Linux
(no CUDA/NVENC required). The GPU zero-copy path is a separate, Linux-only future track
(see ``docs/proposals/active/wgpu_nvenc_zerocopy.md``).

Usage (own your asyncio loop; reuse :func:`pdum.rfb.serve`)::

    import asyncio, pdum.rfb as rfb
    from pdum.rfb.rendercanvas import RfbRenderCanvas, loop
    import pygfx

    async def main():
        display = await rfb.serve(1280, 720, port=8765)
        canvas = RfbRenderCanvas(display=display, size=(1280, 720))
        renderer = pygfx.renderers.WgpuRenderer(canvas)
        scene, camera = build_scene()                  # your pygfx scene
        controller = pygfx.OrbitController(camera, register_events=renderer)

        def animate():
            renderer.render(scene, camera)
            canvas.request_draw(animate)

        canvas.request_draw(animate)
        try:
            await loop.run_async()                     # runs on the current asyncio loop
        finally:
            await display.aclose()

    asyncio.run(main())

Notes
-----
* Browser input (pointer / wheel / key) is drained from the display and delivered to the
  canvas event system, so ``pygfx`` controllers (orbit camera, etc.) work. When you use
  this backend the events go to the **canvas** (``canvas.add_event_handler`` / controllers),
  *not* to ``display.poll_events()`` — the backend drains that queue for you.
* The canvas size (set at construction or via ``set_logical_size``) is the render
  resolution and what gets published. Browser ``resize`` is informational here (the
  publisher owns the resolution), so it is *not* auto-applied — matching the shared-display
  model. Keep the size **even** for the H.264 path.
* Event-schema note: this library emits the `renderview <https://github.com/pygfx/renderview>`_
  vocabulary (``type``/``timestamp``); ``rendercanvas`` 2.x still consumes the legacy keys
  (``event_type``/``time_stamp``). :func:`_to_rendercanvas_event` renames them — the
  *values* (logical coords, ``1=left/2=right/3=middle`` buttons, tuple ``buttons``,
  capitalized ``modifiers``) already match, so it is a pure key-rename. When ``rendercanvas``
  adopts ``type`` it collapses to the identity.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np

try:
    from rendercanvas.asyncio import loop
    from rendercanvas.base import BaseCanvasGroup, BaseRenderCanvas
except ModuleNotFoundError as exc:  # pragma: no cover - exercised only without the extra
    raise ModuleNotFoundError(
        "pdum.rfb.rendercanvas needs the 'rendercanvas' package. Install the optional "
        "extra:  uv add 'habemus-papadum-rfb[rendercanvas]'  (you also need wgpu/pygfx "
        "to actually render)."
    ) from exc

if TYPE_CHECKING:  # pragma: no cover
    from .display import Display

__all__ = ["RfbRenderCanvas", "RenderCanvas", "loop"]

#: Browser event types we forward to the canvas. ``resize``/``set_viewport`` are skipped
#: (the canvas owns its render size); the rest of the renderview vocabulary maps 1:1.
_FORWARD = frozenset({"pointer_move", "pointer_down", "pointer_up", "wheel", "key_down", "key_up"})


def _to_rendercanvas_event(event: dict) -> dict | None:
    """Translate a renderview-shaped ``pdum.rfb`` event to a ``rendercanvas`` event.

    Renames ``type`` → ``event_type`` and ``timestamp`` → ``time_stamp`` (the keys
    ``rendercanvas`` 2.x expects); every value (coords, ``button``/``buttons``,
    ``modifiers``) is already in the shared renderview convention. Returns ``None`` for
    events that should not be forwarded (e.g. ``resize``).
    """
    etype = event.get("type")
    if etype not in _FORWARD:
        return None
    out = dict(event)
    out["event_type"] = etype
    out.pop("type", None)
    ts = out.pop("timestamp", None)
    if ts is not None:
        out["time_stamp"] = ts
    return out


class RfbCanvasGroup(BaseCanvasGroup):
    """Canvas group binding :class:`RfbRenderCanvas` to the shared asyncio loop."""


class RfbRenderCanvas(BaseRenderCanvas):
    """A ``rendercanvas`` backend that publishes each rendered frame to a :class:`~pdum.rfb.display.Display`.

    Parameters
    ----------
    display:
        A started :class:`~pdum.rfb.display.Display` (from ``await pdum.rfb.serve(...)``).
        Rendered frames are published to it and browser input is drained from it.
    size:
        Logical canvas size ``(width, height)`` — the render resolution and the published
        frame size. Defaults to the display's current size.
    **kwargs:
        Forwarded to :class:`rendercanvas.base.BaseRenderCanvas` (``update_mode``,
        ``max_fps``, ``title``, ...).
    """

    _rc_canvas_group = RfbCanvasGroup(loop)

    def __init__(self, *args: Any, display: Display, size: tuple[int, int] | None = None, **kwargs: Any) -> None:
        self._display = display
        self._closed = False
        if size is None:
            size = (display.width, display.height)
        super().__init__(*args, size=size, **kwargs)
        self._final_canvas_init()

    # --- present (the rendered frame) --------------------------------------

    def _rc_get_present_info(self, present_methods: list[str]) -> dict | None:
        if "bitmap" in present_methods:
            return {"method": "bitmap", "formats": ["rgba-u8"]}
        return None  # we have no native surface, so "screen" is unsupported

    def _rc_present_bitmap(self, *, data: Any, format: str, **kwargs: Any) -> None:
        # `data` is a contiguous (H, W, 4) uint8 RGBA array (wgpu downloaded it from the
        # render texture). publish() tags (H, W, 4) as rgba8 and fans it out to viewers.
        if self._closed or self._display._closed:
            return
        self._display.publish(np.asarray(data))

    # --- scheduling (mirror the loop-driven glfw / offscreen backends) ------

    def _rc_request_draw(self) -> None:
        self._time_to_draw()

    def _rc_request_paint(self) -> None:
        # No native surface to repaint: the frame is already published in _rc_present_bitmap.
        pass

    def _rc_force_paint(self) -> None:
        self._time_to_paint()

    def _rc_gui_poll(self) -> None:
        # Called regularly by the scheduler. Drain browser input from all viewers and
        # deliver it to the canvas event system (pygfx controllers, handlers).
        for ev in self._display.poll_events():
            rc_event = _to_rendercanvas_event(ev.event)
            if rc_event is not None:
                self.submit_event(rc_event)

    # --- size / lifecycle --------------------------------------------------

    def _rc_set_logical_size(self, width: float, height: float) -> None:
        # Render at the logical size 1:1 (ratio 1.0); this is what wgpu uses for the render
        # target and what we publish. A different size simply resizes the display on publish.
        w = max(1, int(width))
        h = max(1, int(height))
        self._size_info.set_physical_size(w, h, 1.0)

    def _rc_close(self) -> None:
        self._closed = True

    def _rc_get_closed(self) -> bool:
        return self._closed

    def _rc_set_title(self, title: str) -> None:
        pass

    def _rc_set_cursor(self, cursor: str) -> None:
        pass


#: The conventional export name (``from pdum.rfb.rendercanvas import RenderCanvas``).
RenderCanvas = RfbRenderCanvas
