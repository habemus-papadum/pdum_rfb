"""Built-in demo scenes for ``pdum-rfb demo`` (the interactive harness).

Each :class:`Demo` is a small, self-contained scene the harness can publish into a shared
:class:`~pdum.rfb.display.Display`. A demo is a *factory* (``make()``) so selecting it
starts fresh; the resulting instance exposes:

* ``frame(seq, t, width, height) -> np.ndarray`` — the RGB(A) frame to publish, and
* optionally ``on_event(event) -> None`` — to consume browser input (pointer/key/wheel).

Adding a demo is a few lines: write a ``make`` returning an object with ``frame`` (and
maybe ``on_event``), then append a :class:`Demo` to :data:`DEMOS`. Demos whose
``available()`` returns ``False`` (missing platform/deps) are hidden by the harness.
"""

from __future__ import annotations

import functools
import importlib.util
import sys
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from .testing import render_pattern

# --- the registry type ------------------------------------------------------


@dataclass(slots=True)
class Demo:
    """A selectable demo scene."""

    key: str
    name: str
    description: str
    make: Callable[[], Any]  # () -> instance with .frame(seq, t, w, h) [+ .on_event(ev)]
    available: Callable[[], bool] = field(default=lambda: True)
    tags: tuple[str, ...] = ()  # e.g. ("cpu",), ("mlx", "metal"), ("interactive",)


# --- CPU pattern demos (reuse pdum.rfb.testing.render_pattern) ---------------


class _Pattern:
    """Adapt a ``render_pattern`` name to the demo ``frame`` shape."""

    def __init__(self, pattern: str) -> None:
        self._pattern = pattern

    def frame(self, seq: int, t: float, width: int, height: int) -> np.ndarray:
        return render_pattern(self._pattern, seq, width, height)


class _Plasma:
    """An animated plasma — high-entropy, smooth motion: shows video vs image tradeoffs."""

    def frame(self, seq: int, t: float, width: int, height: int) -> np.ndarray:
        x = np.linspace(0.0, 6.0 * np.pi, width, dtype=np.float32)
        y = np.linspace(0.0, 6.0 * np.pi, height, dtype=np.float32)
        gx, gy = np.meshgrid(x, y)
        v = (
            np.sin(gx + t)
            + np.sin(gy + t * 0.7)
            + np.sin((gx + gy) * 0.5 + t * 1.3)
            + np.sin(np.sqrt(gx * gx + gy * gy) + t)
        )
        r = np.sin(v) * 0.5 + 0.5
        g = np.sin(v + 2.094) * 0.5 + 0.5
        b = np.sin(v + 4.189) * 0.5 + 0.5
        return (np.stack([r, g, b], axis=-1) * 255).astype(np.uint8)


class _Paint:
    """Draw with the mouse — demonstrates the browser→server input round-trip.

    Pointer-down + drag paints; any key clears. Under the frame-pixel coordinate
    contract the browser already sends ``x``/``y`` in framebuffer pixels (mapped
    client-side through the viewport fit), so the server just clamps/rounds them — no
    CSS→pixel scaling needed. Clicks that land in letterbox padding arrive with
    ``inside=False`` and are ignored.
    """

    def __init__(self) -> None:
        self._canvas: np.ndarray | None = None
        self._fb = (0, 0)  # framebuffer size, refreshed each frame()
        self._down = False
        self._last: tuple[int, int] | None = None
        self._hue = 0.0

    def _ensure(self, width: int, height: int) -> np.ndarray:
        if self._canvas is None or self._canvas.shape[:2] != (height, width):
            self._canvas = np.zeros((height, width, 3), np.uint8)
            self._canvas[:] = (18, 18, 24)
        return self._canvas

    def _to_pixels(self, ex: float, ey: float) -> tuple[int, int]:
        """Clamp+round the incoming frame-pixel coordinate to a valid index."""
        w, h = self._fb
        x = int(np.clip(round(ex), 0, max(w - 1, 0)))
        y = int(np.clip(round(ey), 0, max(h - 1, 0)))
        return x, y

    def on_event(self, event: dict) -> None:
        et = event.get("type")
        if et == "resize":
            return  # informational; the publisher owns the render size
        if et == "key_down":
            if self._canvas is not None:
                self._canvas[:] = (18, 18, 24)
            return
        if et == "pointer_down":
            self._down = True
            self._last = None
        elif et == "pointer_up":
            self._down = False
            self._last = None
        elif et == "pointer_move" and self._down and self._canvas is not None:
            if event.get("inside") is False:
                return  # a drag that left the frame (letterbox / crop) — skip
            x, y = self._to_pixels(event.get("x", 0), event.get("y", 0))
            self._hue = (self._hue + 0.01) % 1.0
            color = (np.array(_hsv(self._hue)) * 255).astype(np.uint8)
            self._stamp(x, y, color)
            if self._last is not None:
                self._line(self._last, (x, y), color)
            self._last = (x, y)

    def _stamp(self, x: int, y: int, color: np.ndarray, r: int = 6) -> None:
        c = self._canvas
        assert c is not None
        h, w = c.shape[:2]
        x0, x1 = max(0, x - r), min(w, x + r + 1)
        y0, y1 = max(0, y - r), min(h, y + r + 1)
        c[y0:y1, x0:x1] = color

    def _line(self, a: tuple[int, int], b: tuple[int, int], color: np.ndarray) -> None:
        n = max(abs(b[0] - a[0]), abs(b[1] - a[1]), 1)
        for i in range(n + 1):
            x = int(a[0] + (b[0] - a[0]) * i / n)
            y = int(a[1] + (b[1] - a[1]) * i / n)
            self._stamp(x, y, color)

    def frame(self, seq: int, t: float, width: int, height: int) -> np.ndarray:
        self._fb = (width, height)
        return self._ensure(width, height)


def _hsv(h: float) -> tuple[float, float, float]:
    """Tiny HSV→RGB (s=v=1)."""
    i = int(h * 6) % 6
    f = h * 6 - int(h * 6)
    q, tt = 1 - f, f
    return [(1, tt, 0), (q, 1, 0), (0, 1, tt), (0, q, 1), (tt, 0, 1), (1, 0, q)][i]


# --- MLX / Metal demo (macOS, Apple Silicon) --------------------------------


@functools.lru_cache(maxsize=1)
def _mlx_available() -> bool:
    return sys.platform == "darwin" and importlib.util.find_spec("mlx") is not None


class _MlxShader:
    """Render RGBA on the GPU with a custom MLX Metal kernel, then publish the ``mx.array``.

    Showcases an MLX/Metal frame producer end-to-end: ``frame()`` returns the Metal
    ``mx.array`` directly, so ``display.publish()`` treats it as a ``memory="metal"`` frame.
    On the **VideoToolbox** backend the RGB→NV12 conversion runs on the GPU (``pdum.rfb.metal``,
    ~23× cheaper than the CPU path, off the core); on any other backend the frame is downloaded
    to host automatically. See ``docs/guide_python.md`` (MLX / Apple Metal frames).
    """

    def __init__(self) -> None:
        import mlx.core as mx

        self._mx = mx
        self._kernel = mx.fast.metal_kernel(
            name="demo_shader",
            input_names=["t"],
            output_names=["out"],
            source="""
                uint x = thread_position_in_grid.x;
                uint y = thread_position_in_grid.y;
                if (x >= W || y >= H) return;
                uint i = (y * W + x) * 4;
                float fx = float(x) / float(W);
                float fy = float(y) / float(H);
                float tt = t[0];
                float swirl = sin(10.0f * fx + tt) * cos(10.0f * fy - tt);
                out[i + 0] = (uint8_t)(255.0f * (0.5f + 0.5f * sin(tt + fx * 6.28f)));
                out[i + 1] = (uint8_t)(255.0f * (0.5f + 0.5f * swirl));
                out[i + 2] = (uint8_t)(255.0f * fy);
                out[i + 3] = (uint8_t)255;
            """,
        )

    def frame(self, seq: int, t: float, width: int, height: int):
        """Return the rendered RGBA as a Metal ``mx.array`` (publish() materializes it)."""
        mx = self._mx
        (out,) = self._kernel(
            inputs=[mx.array([t], dtype=mx.float32)],
            template=[("W", width), ("H", height)],
            grid=(width, height, 1),
            threadgroup=(16, 16, 1),
            output_shapes=[(height, width, 4)],
            output_dtypes=[mx.uint8],
        )
        return out


# --- the built-in registry --------------------------------------------------

DEMOS: list[Demo] = [
    Demo(
        "test_card",
        "Test card",
        "Static 4-quadrant color/decode reference.",
        lambda: _Pattern("test_card"),
        tags=("cpu",),
    ),
    Demo(
        "bouncing_box",
        "Bouncing box",
        "A box bouncing on a gradient — light motion.",
        lambda: _Pattern("bouncing_box"),
        tags=("cpu",),
    ),
    Demo(
        "gradient",
        "Moving gradient",
        "A scrolling gradient — smooth, low entropy.",
        lambda: _Pattern("gradient"),
        tags=("cpu",),
    ),
    Demo(
        "checkerboard",
        "Checkerboard",
        "High-contrast checkerboard — stresses detail.",
        lambda: _Pattern("checkerboard"),
        tags=("cpu",),
    ),
    Demo("plasma", "Plasma", "Animated plasma — high entropy, great for video codecs.", _Plasma, tags=("cpu",)),
    Demo(
        "paint",
        "Paint (interactive)",
        "Drag the mouse to draw; press any key to clear.",
        _Paint,
        tags=("cpu", "interactive"),
    ),
    Demo(
        "mlx_shader",
        "MLX shader (Metal)",
        "GPU-rendered swirl via a custom MLX Metal kernel.",
        _MlxShader,
        available=_mlx_available,
        tags=("mlx", "metal", "gpu"),
    ),
]


def available_demos() -> list[Demo]:
    """The demos viable on this machine (filters out unavailable platform/deps)."""
    return [d for d in DEMOS if _safe(d.available)]


def _safe(fn: Callable[[], bool]) -> bool:
    try:
        return bool(fn())
    except Exception:
        return False


def get_demo(key: str) -> Demo:
    for d in DEMOS:
        if d.key == key:
            return d
    raise KeyError(key)
