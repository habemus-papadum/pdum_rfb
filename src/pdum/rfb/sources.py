"""Frame sources: base bookkeeping plus a render-callback adapter.

A :class:`FrameSource` produces raw frames and consumes user-input events.
:class:`BaseFrameSource` owns the boring-but-easy-to-get-wrong bookkeeping
(sequence numbers, microsecond timestamps, fps pacing, event recording and
viewport tracking) so concrete sources only implement :meth:`render`.

The deterministic, GUI-free :class:`~pdum.rfb.testing.SyntheticFrameSource`
used by the tests and the demo server lives in :mod:`pdum.rfb.testing`.
"""

from __future__ import annotations

import asyncio
import time
from abc import ABC, abstractmethod
from typing import Callable

import numpy as np

from .types import EventDict, PixelFormat, RawFrame


class BaseFrameSource(ABC):
    """Common bookkeeping for frame sources.

    Parameters
    ----------
    width, height:
        Initial framebuffer size in pixels (forced even for codec friendliness).
    fps:
        Target frame rate used for pacing when ``pace`` is true.
    pixel_format:
        ``"rgb24"`` or ``"rgba8"``; :meth:`render` must return matching arrays.
    max_frames:
        If set, :meth:`next_frame` raises ``StopAsyncIteration`` after this many.
    pace:
        When true, :meth:`next_frame` sleeps to approximate ``fps``. Tests set
        this false to run as fast as possible.
    clock:
        Monotonic clock returning seconds; injectable for deterministic tests.
    """

    def __init__(
        self,
        *,
        width: int = 640,
        height: int = 480,
        fps: int = 30,
        pixel_format: PixelFormat = "rgb24",
        max_frames: int | None = None,
        pace: bool = True,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.width = _make_even(width)
        self.height = _make_even(height)
        self.fps = fps
        self.pixel_format = pixel_format
        self.max_frames = max_frames
        self.pace = pace
        self._clock = clock or time.monotonic

        self.seq = 0
        self.frames_produced = 0
        self.events: list[EventDict] = []
        self._start = self._clock()
        self._next_due = self._start

    @property
    def current_size(self) -> tuple[int, int]:
        return (self.width, self.height)

    @abstractmethod
    def render(self, seq: int, t_us: int) -> np.ndarray:
        """Return the pixel array for frame ``seq`` at timestamp ``t_us``.

        Must be deterministic in ``seq`` and match ``self.pixel_format``.
        """

    def _produce_frame(self) -> RawFrame:
        """Render the current frame with a real monotonic timestamp."""
        t_us = int((self._clock() - self._start) * 1_000_000)
        arr = self.render(self.seq, t_us)
        frame = RawFrame(
            seq=self.seq,
            width=self.width,
            height=self.height,
            timestamp_us=t_us,
            pixel_format=self.pixel_format,
            memory="cpu",
            data=arr,
        )
        self.seq += 1
        self.frames_produced += 1
        return frame

    async def next_frame(self) -> RawFrame:
        if self.max_frames is not None and self.frames_produced >= self.max_frames:
            raise StopAsyncIteration

        if self.pace:
            self._next_due += 1.0 / self.fps
            delay = self._next_due - self._clock()
            if delay > 0:
                await asyncio.sleep(delay)

        return self._produce_frame()

    async def handle_event(self, event: EventDict) -> None:
        recorded = dict(event)
        recorded["_received_us"] = int((self._clock() - self._start) * 1_000_000)
        self.events.append(recorded)
        if event.get("type") == "resize":
            self.width = _make_even(int(event["width"]))
            self.height = _make_even(int(event["height"]))

    def snapshot_events(self) -> list[EventDict]:
        """Return a copy of all events received so far, in order."""
        return list(self.events)


class RenderCallbackSource(BaseFrameSource):
    """Adapt a plain ``render(seq, t_us) -> ndarray`` callable into a source."""

    def __init__(self, render: Callable[[int, int], np.ndarray], **kwargs) -> None:
        super().__init__(**kwargs)
        self._render = render

    def render(self, seq: int, t_us: int) -> np.ndarray:
        return self._render(seq, t_us)


class OnDemandFrameSource(BaseFrameSource):
    """A sparse, event-driven source that renders only when marked dirty.

    For scientific visualization the framebuffer often changes only when the user
    interacts or a parameter updates (guide addendum, section 1). Instead of
    fabricating duplicate frames at a fixed rate, :meth:`next_frame` parks until
    :meth:`mark_dirty` is called (or, by default, until an input event arrives),
    then emits a single frame with a real timestamp. The session's latest-frame-
    wins policy and the encoder's keyframe handling are unchanged.

    Parameters
    ----------
    render:
        ``render(seq, t_us) -> ndarray`` producing the current frame.
    render_on_event:
        When true (default), any received input event marks the source dirty so
        interaction re-renders automatically.
    """

    def __init__(
        self,
        render: Callable[[int, int], np.ndarray],
        *,
        render_on_event: bool = True,
        **kwargs,
    ) -> None:
        kwargs.setdefault("pace", False)
        super().__init__(**kwargs)
        self._render_fn = render
        self._render_on_event = render_on_event
        self._dirty = asyncio.Event()
        self._dirty.set()  # emit one frame on connect

    def mark_dirty(self) -> None:
        """Request that the next :meth:`next_frame` produces a fresh frame."""
        self._dirty.set()

    def render(self, seq: int, t_us: int) -> np.ndarray:
        return self._render_fn(seq, t_us)

    async def next_frame(self) -> RawFrame:
        if self.max_frames is not None and self.frames_produced >= self.max_frames:
            raise StopAsyncIteration
        await self._dirty.wait()
        self._dirty.clear()
        return self._produce_frame()

    async def handle_event(self, event: EventDict) -> None:
        await super().handle_event(event)
        if self._render_on_event:
            self.mark_dirty()


def _make_even(n: int) -> int:
    """Round down to the nearest even number (yuv420p requires even dims)."""
    return n - (n % 2)
