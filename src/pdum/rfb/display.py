"""The push-model :class:`Display`: you publish frames, viewers attach to watch.

The application owns its loop and *pushes* the latest frame into a ``Display``;
the library fans that frame out to every connected browser, each driven by its own
:class:`~pdum.rfb.session.RfbSession` and encoder (so each viewer gets a keyframe
on attach and independent latest-frame-wins backpressure). Input events from all
viewers funnel into one stream the application drains with :meth:`poll_events`.

```python
display = await rfb.serve(1280, 720, port=8765)   # background WS server + handle
state = init()
while running:
    for ev in display.poll_events():     # ev.client_id, ev.principal, ev.event
        state = update(state, ev)
    display.publish(render(state))       # sync, non-blocking, latest-wins
    await asyncio.sleep(1 / 30)          # or ad-hoc / every 60 s — you own the cadence
await display.aclose()
```

``publish()`` must be called on the event-loop thread (it wakes feeds via
``asyncio.Event``). Publishing a differently-shaped array transparently rebuilds
each viewer's encoder and forces a keyframe; keep ``pixel_format`` constant.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
from collections import deque
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable

import numpy as np

from .auth import Principal
from .types import EventDict, InputEvent, RawFrame

if TYPE_CHECKING:  # pragma: no cover
    from .session import RfbSession


def _is_cuda_tensor(obj: Any) -> bool:
    """True for a CUDA-resident tensor (CuPy / Numba / CUDA DLPack)."""
    if hasattr(obj, "__cuda_array_interface__"):
        return True
    dldev = getattr(obj, "__dlpack_device__", None)
    if dldev is not None:
        try:
            return dldev()[0] in (2, 13)  # DLDeviceType: kDLCUDA, kDLCUDAManaged
        except Exception:  # pragma: no cover - defensive
            return False
    return False


class Display:
    """A single shared framebuffer that one or more browsers attach to.

    Parameters
    ----------
    width, height:
        Initial framebuffer size. Updated automatically whenever you publish a
        differently-shaped frame.
    fps:
        Advisory frame rate (used as the encoder's IDR cadence / metrics target);
        the *actual* cadence is whatever your publish loop does.
    record_events:
        Also accumulate raw events in :attr:`recorded` (exposed via the server's
        ``GET /recorded-events`` side channel and the headless e2e harness).
    event_log:
        Optional path; received events are appended as JSON lines.
    event_queue_size:
        Bound on the un-polled event backlog; the **oldest** events are dropped
        when a publisher never calls :meth:`poll_events`.
    clock:
        Monotonic clock returning seconds; injectable for deterministic tests.
    """

    def __init__(
        self,
        width: int,
        height: int,
        *,
        fps: int = 30,
        record_events: bool = False,
        event_log: str | Path | None = None,
        event_queue_size: int = 4096,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.width = int(width)
        self.height = int(height)
        self.fps = fps
        self._clock = clock or time.monotonic
        self._start = self._clock()

        self._latest: RawFrame | None = None
        self._version = 0
        self._feeds: set[_ClientFeed] = set()
        self._sessions: set[RfbSession] = set()
        self._clients: dict[str, _ClientFeed] = {}

        self._events: deque[InputEvent] = deque(maxlen=event_queue_size)
        self._events_signal = asyncio.Event()

        self._record_events = record_events or event_log is not None
        self._event_log = Path(event_log) if event_log else None
        self.recorded: list[EventDict] = []

        self._closed = False
        # Set by serve() so aclose() can stop the listener it started.
        self._server: Any = None
        self._server_cm: Any = None
        # Set by Server.add_stream() so display.server.add_stream(...) works.
        self._owner_server: Any = None

    # --- publishing --------------------------------------------------------

    def publish(self, frame: np.ndarray | RawFrame | Any) -> None:
        """Make ``frame`` the latest frame and wake every connected viewer.

        Synchronous and non-blocking. ``frame`` may be:

        * a contiguous host ``uint8`` array — ``(H, W, 3)`` ``rgb24`` or
          ``(H, W, 4)`` ``rgba8``;
        * a **CUDA tensor** exposing ``__cuda_array_interface__`` (e.g. CuPy) of
          shape ``(H, W, 3|4)`` — published as a zero-copy ``cuda`` frame (for
          NV12, or other frameworks, build a ``RawFrame`` via
          :func:`pdum.rfb.gpu.cuda_frame`);
        * a ready :class:`~pdum.rfb.types.RawFrame` (any ``memory``).

        Latest-frame-wins: a viewer that is behind simply skips intermediate
        frames. Publish a *fresh* buffer each call — viewers share the reference
        and may read it asynchronously.
        """
        if self._closed:
            raise RuntimeError("publish() called on a closed Display")

        if isinstance(frame, RawFrame):
            data, width, height = frame.data, frame.width, frame.height
            pixel_format, memory = frame.pixel_format, frame.memory
        elif isinstance(frame, np.ndarray):
            if frame.ndim != 3 or frame.shape[2] not in (3, 4):
                raise ValueError(f"unsupported frame shape {frame.shape!r}; expected (H, W, 3) or (H, W, 4)")
            height, width = int(frame.shape[0]), int(frame.shape[1])
            pixel_format = "rgb24" if frame.shape[2] == 3 else "rgba8"
            data, memory = frame, "cpu"
        elif _is_cuda_tensor(frame):
            shape = getattr(frame, "shape", None)
            if shape is None or len(shape) != 3 or shape[2] not in (3, 4):
                raise ValueError("CUDA publish expects an (H, W, 3|4) tensor; use pdum.rfb.gpu.cuda_frame() for NV12")
            height, width = int(shape[0]), int(shape[1])
            pixel_format = "rgb24" if shape[2] == 3 else "rgba8"
            data, memory = frame, "cuda"
        else:
            raise TypeError("publish() expects a numpy.ndarray, a CUDA tensor, or a RawFrame")

        timestamp_us = int((self._clock() - self._start) * 1_000_000)
        # seq is a placeholder; each feed stamps its own per-client sequence.
        self._latest = RawFrame(
            seq=0,
            width=width,
            height=height,
            timestamp_us=timestamp_us,
            pixel_format=pixel_format,  # type: ignore[arg-type]
            memory=memory,  # type: ignore[arg-type]
            data=data,
        )
        self.width, self.height = width, height
        self._version += 1
        for feed in self._feeds:
            feed._wake()

    # --- events ------------------------------------------------------------

    def poll_events(self) -> list[InputEvent]:
        """Drain and return all input events received since the last poll."""
        out = list(self._events)
        self._events.clear()
        return out

    async def events(self) -> AsyncIterator[InputEvent]:
        """Async-iterate input events (alternative to :meth:`poll_events`).

        Use one or the other — both drain the same queue.
        """
        while not self._closed:
            if self._events:
                yield self._events.popleft()
                continue
            self._events_signal.clear()
            await self._events_signal.wait()

    @property
    def client_count(self) -> int:
        """Number of currently connected viewers."""
        return len(self._feeds)

    @property
    def port(self) -> int | None:
        """The bound TCP port (useful when serving with ``port=0``)."""
        if self._server is None:
            return None
        return next(iter(self._server.sockets)).getsockname()[1]

    @property
    def server(self) -> Any:
        """The owning :class:`~pdum.rfb.server.Server` hub, if this is a stream of one.

        Lets the convenience ``display = await serve(...)`` path reach the hub to add
        more streams: ``display.server.add_stream("camera_b", 640, 480)``. ``None``
        for a bare ``Display`` constructed directly.
        """
        return self._owner_server

    # --- lifecycle ---------------------------------------------------------

    def _close_local(self) -> None:
        """Disconnect viewers and wake waiters, *without* stopping any listener.

        The per-stream half of teardown: a hub (:class:`~pdum.rfb.server.Server`)
        calls this on each stream while it stops the shared listener once.
        """
        if self._closed:
            return
        self._closed = True
        for feed in list(self._feeds):
            feed.close()
        self._events_signal.set()

    async def aclose(self) -> None:
        """Stop the server, disconnect viewers, and release encoder resources."""
        self._close_local()
        if self._server_cm is not None:
            cm, self._server_cm = self._server_cm, None
            self._server = None
            await cm.__aexit__(None, None, None)

    # --- internal (used by the connection server) --------------------------

    def _enqueue_event(self, client_id: str, principal: Principal | None, event: EventDict) -> None:
        received_us = int((self._clock() - self._start) * 1_000_000)
        self._events.append(InputEvent(client_id=client_id, principal=principal, event=event, received_us=received_us))
        self._events_signal.set()
        if self._record_events:
            self.recorded.append(event)
            if self._event_log is not None:
                with self._event_log.open("a") as fh:
                    fh.write(json.dumps(event) + "\n")

    def _make_feed(self, client_id: str, principal: Principal | None) -> _ClientFeed:
        feed = _ClientFeed(self, client_id, principal)
        self._feeds.add(feed)
        self._clients[client_id] = feed
        return feed

    def _register_session(self, session: RfbSession) -> None:
        self._sessions.add(session)

    def _remove(self, client_id: str, feed: _ClientFeed, session: RfbSession | None) -> None:
        self._feeds.discard(feed)
        self._clients.pop(client_id, None)
        if session is not None:
            self._sessions.discard(session)


class _ClientFeed:
    """Per-connection adapter that feeds one :class:`RfbSession` (internal SPI).

    Implements the ``FrameSource`` shape (``next_frame`` / ``handle_event``) the
    session pulls. Each feed owns its own wakeup ``Event`` and ``seq`` counter, so
    one :meth:`Display.publish` cleanly wakes all parked feeds and every encoder
    sees a dense sequence starting at its own keyframe.
    """

    __slots__ = ("_display", "client_id", "principal", "_seq", "_last_seen", "_event", "_closed", "viewport")

    def __init__(self, display: Display, client_id: str, principal: Principal | None) -> None:
        self._display = display
        self.client_id = client_id
        self.principal = principal
        self._seq = 0
        self._last_seen = 0
        self._event = asyncio.Event()
        self._closed = False
        self.viewport: tuple[int, int, float] | None = None

    def _wake(self) -> None:
        self._event.set()

    def close(self) -> None:
        """Stop this feed so the session's encode loop unparks and exits."""
        self._closed = True
        self._event.set()

    async def next_frame(self) -> RawFrame:
        while True:
            if self._closed or self._display._closed:
                raise StopAsyncIteration
            latest = self._display._latest
            version = self._display._version
            if latest is not None and version > self._last_seen:
                self._last_seen = version
                # Share the published ndarray; assign this client's own seq and
                # keep the publish-time (shared) timestamp.
                frame = dataclasses.replace(latest, seq=self._seq)
                self._seq += 1
                return frame
            # No await between the check above and clear()/wait() below, so on a
            # single event loop no publish can interleave and lose a wakeup.
            self._event.clear()
            await self._event.wait()

    def still_frame(self) -> RawFrame | None:
        """Return the current latest frame with a fresh per-client ``seq``.

        Used by the session's "still after settle" path to re-send the resting
        frame at higher quality. It assigns a new ``seq`` (so the client acks it
        distinctly) but does **not** advance ``_last_seen``, so a frame published
        after the still is still delivered normally by :meth:`next_frame`. Returns
        ``None`` if nothing has been published yet.
        """
        latest = self._display._latest
        if latest is None:
            return None
        frame = dataclasses.replace(latest, seq=self._seq)
        self._seq += 1
        return frame

    async def handle_event(self, event: EventDict) -> None:
        if event.get("type") in ("resize", "set_viewport"):
            # Informational only in a shared display: the publisher owns the
            # render resolution. We record the viewport (physical/render-buffer
            # size + ratio) for future per-client use. Renderview carries physical
            # dims as pwidth/pheight; fall back to width/height for older clients.
            pw = event.get("pwidth", event.get("width"))
            ph = event.get("pheight", event.get("height"))
            ratio = event.get("ratio", event.get("pixel_ratio", 1))
            self.viewport = (int(pw), int(ph), float(ratio))
        self._display._enqueue_event(self.client_id, self.principal, event)
