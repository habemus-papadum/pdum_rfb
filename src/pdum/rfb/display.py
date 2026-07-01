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
import sys
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


def _color_to_dict(color: Any) -> dict | None:
    """Normalize a color descriptor (``ColorSpace`` | ``dict`` | ``None``) to its wire dict."""
    if color is None or isinstance(color, dict):
        return color
    to_dict = getattr(color, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    raise TypeError(f"unsupported color descriptor {type(color)!r}; pass a ColorSpace or a dict")


def _is_metal_tensor(obj: Any) -> bool:
    """True for an MLX (Apple Metal, unified-memory) array."""
    t = type(obj)
    if t.__module__.split(".")[0] == "mlx" and t.__name__ == "array":
        return True
    dldev = getattr(obj, "__dlpack_device__", None)
    if dldev is not None:
        try:
            return dldev()[0] == 8  # DLDeviceType.kDLMetal
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
    own_frames:
        Opt in to **server-owned frames**. By default :meth:`publish` *borrows* the
        caller's buffer (zero-copy) and reads it asynchronously, so you must publish a
        fresh buffer each call (or not mutate it until it is encoded). With
        ``own_frames=True`` each published frame is **copied into a server-owned,
        recycled buffer** on the publish thread, so you may reuse/mutate your own buffer
        immediately after :meth:`publish` returns — no reallocation and no "frame
        released" callback. Supported for ``cpu`` and ``cuda`` frames; ``metal`` raises
        (MLX arrays are immutable, so the borrow contract already holds). See
        :meth:`publish`.
    resize_policy:
        ``"publisher"`` (default) — you own the render size and a viewer's ``set_viewport``
        is informational. ``"match_client"`` — the render stream *follows the viewer*: the
        latest ``set_viewport`` becomes :attr:`target_size` (last-writer-wins across viewers),
        which your render loop reads to size the next frame.
    max_render_dimension:
        Cap on either dimension of a ``match_client`` :attr:`target_size` (AR-preserving),
        guarding against a maximized 4K window forcing a huge encode. ``None`` = no cap.
    resize_debounce:
        Seconds a ``match_client`` target must be stable before it surfaces through
        :attr:`target_size`, so a drag-resize doesn't storm the encoder rebuild (default 0.12).
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
        own_frames: bool = False,
        resize_policy: str = "publisher",
        max_render_dimension: int | None = None,
        resize_debounce: float = 0.12,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.width = int(width)
        self.height = int(height)
        self.fps = fps
        self._clock = clock or time.monotonic
        self._start = self._clock()

        # "match-client" resize policy: when enabled, a viewer's set_viewport becomes a
        # *target size* the render loop follows (default "publisher" = you own the size,
        # set_viewport is informational). Last-writer-wins across viewers; debounced so a
        # drag-resize doesn't storm the encoder rebuild; clamped to max_render_dimension.
        if resize_policy not in ("publisher", "match_client"):
            raise ValueError(f"resize_policy must be 'publisher' or 'match_client', got {resize_policy!r}")
        self.resize_policy = resize_policy
        self.max_render_dimension = max_render_dimension
        self._resize_debounce = float(resize_debounce)
        self._pending_target: tuple[int, int] | None = None
        self._pending_ratio = 1.0
        self._pending_at = 0.0
        self._committed_target: tuple[int, int] | None = None
        self._committed_ratio = 1.0

        self._latest: RawFrame | None = None
        self._version = 0
        # Opt-in frame ownership (own_frames=True): publish() copies each frame into a
        # server-owned buffer drawn from this recycled pool, so the caller may reuse its
        # buffer immediately. Empty/unused when own_frames is False. See _own_copy / _take_owned.
        self._own_frames = bool(own_frames)
        self._own_pool: list[Any] = []
        self._own_key: tuple[Any, ...] | None = None
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
        # The URL path segment this stream is reached at (set by Server.add_stream()).
        self._stream_name: str = "default"

    # --- publishing --------------------------------------------------------

    def publish(
        self,
        frame: np.ndarray | RawFrame | Any,
        *,
        pixel_ratio: float | None = None,
        color: Any = None,
    ) -> None:
        """Make ``frame`` the latest frame and wake every connected viewer.

        Synchronous and non-blocking. ``frame`` may be:

        * a contiguous host ``uint8`` array — ``(H, W, 3)`` ``rgb24`` or
          ``(H, W, 4)`` ``rgba8``;
        * a **CUDA tensor** exposing ``__cuda_array_interface__`` (e.g. CuPy) of
          shape ``(H, W, 3|4)`` — published as a zero-copy ``cuda`` frame (for
          NV12, or other frameworks, build a ``RawFrame`` via
          :func:`pdum.rfb.gpu.cuda_frame`);
        * an **MLX (Apple Metal) array** of shape ``(H, W, 3|4)`` — published as a
          ``metal`` frame; the VideoToolbox encoder converts RGB(A)→NV12 on the GPU
          (for pre-converted NV12, use :func:`pdum.rfb.metal.metal_frame`);
        * a ready :class:`~pdum.rfb.types.RawFrame` (any ``memory``).

        Latest-frame-wins: a viewer that is behind simply skips intermediate frames.

        **Ownership.** By default ``publish()`` *borrows* your buffer — it stores a bare
        reference and reads the pixels **asynchronously**, on each viewer's encode worker
        thread. The borrow window runs from here until every viewer has finished encoding
        the frame, and it is **widest under** ``still_after`` (the resting frame is re-read
        ~``still_after`` seconds later for the lossless still). So in borrow mode, publish a
        *fresh* buffer each call, or do not mutate a published buffer until it is encoded.
        Construct the ``Display`` (or call :func:`~pdum.rfb.serve`) with ``own_frames=True``
        to instead have the server copy each frame into a recycled buffer, after which you
        may reuse/mutate your own buffer immediately (``cpu``/``cuda`` only; ``metal`` raises).

        Parameters
        ----------
        pixel_ratio:
            Render-side DPR for this frame (device px per logical px). ``None`` keeps a
            :class:`~pdum.rfb.types.RawFrame`'s own value (else ``1.0``). See
            :attr:`~pdum.rfb.types.RawFrame.pixel_ratio`.
        color:
            Color descriptor for this frame — a :class:`~pdum.rfb.types.ColorSpace`, its
            ``dict`` form, or ``None`` (sRGB). The renderer must already produce pixels in
            the declared space; the library only tags them.
        """
        if self._closed:
            raise RuntimeError("publish() called on a closed Display")

        frame_pr = frame.pixel_ratio if isinstance(frame, RawFrame) else 1.0
        frame_color = frame.color if isinstance(frame, RawFrame) else None
        resolved_pr = float(frame_pr if pixel_ratio is None else pixel_ratio)
        resolved_color = frame_color if color is None else _color_to_dict(color)

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
        elif _is_metal_tensor(frame):
            shape = getattr(frame, "shape", None)
            if shape is None or len(shape) != 3 or shape[2] not in (3, 4):
                raise ValueError(
                    "Metal publish expects an (H, W, 3|4) MLX array; use pdum.rfb.metal.metal_frame() for NV12"
                )
            height, width = int(shape[0]), int(shape[1])
            pixel_format = "rgb24" if shape[2] == 3 else "rgba8"
            data, memory = frame, "metal"
        else:
            raise TypeError("publish() expects a numpy.ndarray, a CUDA/Metal tensor, or a RawFrame")

        if memory == "metal":
            # Materialize the lazy MLX render on *this* (loop) thread: MLX binds a lazy graph to
            # its origin thread's stream, so the session's encode worker thread cannot evaluate a
            # frame built here. The GPU NV12 conversion still runs on the worker. See metal.materialize.
            from .metal import materialize

            materialize(data)

        if self._own_frames:
            # Server-owned mode: copy into a recycled buffer on this (loop) thread so the caller
            # may reuse/mutate its own buffer immediately. Severs the async-read aliasing entirely.
            data = self._own_copy(data, memory)

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
            pixel_ratio=resolved_pr,
            color=resolved_color,
        )
        self.width, self.height = width, height
        self._version += 1
        for feed in self._feeds:
            feed._wake()

    def _own_copy(self, data: Any, memory: str) -> Any:
        """Copy ``data`` into a server-owned buffer (``own_frames`` mode) so the caller may
        reuse its own buffer immediately. Runs on the loop thread. ``cpu`` → numpy, ``cuda`` →
        CuPy device-to-device; ``metal`` is unsupported (MLX is immutable — borrow already holds)."""
        if memory == "cpu":
            arr = np.asarray(data)
            buf = self._take_owned(arr.shape, arr.dtype, memory)
            np.copyto(buf, arr)
            return buf
        if memory == "cuda":
            import cupy as cp  # lazy: only when a cuda frame is published under own_frames

            src = cp.asarray(data)
            buf = self._take_owned(src.shape, src.dtype, memory)
            cp.copyto(buf, src)
            return buf
        raise NotImplementedError(
            "own_frames is not supported for Metal frames; publish a fresh mx.array per frame "
            "(MLX arrays are immutable, so the borrow contract already holds). See docs/metal_videotoolbox.md."
        )

    def _take_owned(self, shape: tuple[int, ...], dtype: Any, memory: str) -> Any:
        """Return a reusable server-owned buffer of ``(shape, dtype, memory)`` that no in-flight
        frame still references. A size/dtype/memory change drops the pool (reallocate, like the
        encoder rebuild on resize).

        Correctness rests on CPython refcounting: while a session holds ``frame =
        replace(latest, seq)`` across its off-thread encode, that buffer's refcount is elevated,
        so it is skipped here and never overwritten mid-encode. Steady state the pool stabilizes
        at ~(concurrently-encoding viewers + 1) buffers and recycles them — no per-frame alloc."""
        key = (shape, dtype, memory)
        if key != self._own_key:
            self._own_pool = []
            self._own_key = key
        pool = self._own_pool
        for i in range(len(pool)):
            # getrefcount == 2 means the only refs are the pool slot + getrefcount's own argument,
            # i.e. nothing else holds it. Index as pool[i] (no bound local), or a temporary local
            # would add one and mask a free buffer.
            if sys.getrefcount(pool[i]) <= 2:
                return pool[i]
        if memory == "cuda":
            import cupy as cp

            buf = cp.empty(shape, dtype)
        else:
            buf = np.empty(shape, dtype)  # C-contiguous regardless of caller layout
        pool.append(buf)
        return buf

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
    def pixel_ratio(self) -> float:
        """Render-side DPR of the latest published frame (``1.0`` before the first publish)."""
        return self._latest.pixel_ratio if self._latest is not None else 1.0

    @property
    def color(self) -> dict | None:
        """Color descriptor of the latest published frame, or ``None`` (sRGB)."""
        return self._latest.color if self._latest is not None else None

    # --- match-client resize (opt-in) --------------------------------------

    def _clamp_render_size(self, w: int, h: int) -> tuple[int, int]:
        """Clamp a requested render size to ``max_render_dimension`` (AR-preserving) and to
        even, >= 2 dimensions (H.264 / NV12 need even). ``max_render_dimension=None`` = no cap."""
        w, h = max(2, int(w)), max(2, int(h))
        cap = self.max_render_dimension
        if cap is not None and max(w, h) > cap:
            scale = cap / max(w, h)
            w, h = max(2, round(w * scale)), max(2, round(h * scale))
        return (w - (w % 2), h - (h % 2))

    def _request_target(self, pw: int, ph: int, ratio: float) -> None:
        """Record a viewer's requested render size (``match_client`` only). Debounced: the
        value surfaces through :attr:`target_size` after it has been stable for
        ``resize_debounce`` seconds, so a drag-resize doesn't storm the encoder rebuild."""
        size = self._clamp_render_size(pw, ph)
        if size != self._pending_target:
            self._pending_target = size
            self._pending_ratio = float(ratio)
            self._pending_at = self._clock()

    def _settle_target(self) -> None:
        if self._pending_target is not None and (self._clock() - self._pending_at) >= self._resize_debounce:
            self._committed_target = self._pending_target
            self._committed_ratio = self._pending_ratio
            self._pending_target = None

    @property
    def target_size(self) -> tuple[int, int] | None:
        """Latest client-requested render size under ``resize_policy="match_client"`` (debounced,
        clamped, even dims), or ``None`` before any viewport arrives / in ``"publisher"`` mode.

        Read it in your render loop to follow the viewer::

            w, h = display.target_size or (display.width, display.height)
            display.publish(render(state, w, h), pixel_ratio=display.target_ratio)
        """
        self._settle_target()
        return self._committed_target

    @property
    def target_ratio(self) -> float:
        """The client DPR that accompanies :attr:`target_size` (``1.0`` until one arrives)."""
        self._settle_target()
        return self._committed_ratio

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

    @property
    def ws_url(self) -> str:
        """Browser-reachable WebSocket URL for this stream (e.g. ``ws://host:port/name``).

        Raises if the server is not bound yet (call ``await rfb.serve(...)`` first). A
        wildcard bind host (``0.0.0.0``/``::``) is reported as ``127.0.0.1``.
        """
        if self.port is None:
            raise RuntimeError("Display is not serving yet; call await rfb.serve(...) first")
        host = getattr(self._owner_server, "host", None) or "127.0.0.1"
        if host in ("0.0.0.0", "", "::"):
            host = "127.0.0.1"
        return f"ws://{host}:{self.port}/{self._stream_name}"

    def widget(
        self,
        *,
        batteries: bool = True,
        base_path: str | None = None,
        host: str | None = None,
        **chrome: Any,
    ) -> Any:
        """Return an anywidget viewer bound to this stream (needs the ``[anywidget]`` extra).

        In a notebook: ``display.widget()`` renders the batteries viewer;
        ``display.widget(batteries=False)`` the bare canvas. One widget = one Web Worker +
        one WebSocket; the server multiplexes many streams on one port. For remote/HTTPS
        notebooks, mount ``pdum.rfb.asgi.rfb_hub_endpoint`` same-origin and pass
        ``base_path=`` (the widget then uses a same-origin ``wss://`` URL). Extra keyword
        args (e.g. ``show_toolbar=False``) become widget traits.

        Raises if the server is not bound yet.
        """
        from .notebook import RfbCanvas, RfbViewer

        if self.port is None:
            raise RuntimeError("Display is not serving yet; call await rfb.serve(...) first")
        resolved_host = host if host is not None else (getattr(self._owner_server, "host", None) or "127.0.0.1")
        if resolved_host in ("0.0.0.0", "", "::"):
            # Let the browser use the page's own hostname (correct for remote notebooks).
            resolved_host = "auto"
        cls = RfbViewer if batteries else RfbCanvas
        kwargs: dict[str, Any] = {"port": self.port, "stream": self._stream_name, "host": resolved_host, **chrome}
        if base_path is not None:
            kwargs["base_path"] = base_path
        return cls(**kwargs)

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
            # Record the viewport (physical/render-buffer size + ratio). Renderview carries
            # physical dims as pwidth/pheight; fall back to width/height for older clients.
            pw = int(event.get("pwidth", event.get("width")))
            ph = int(event.get("pheight", event.get("height")))
            ratio = float(event.get("ratio", event.get("pixel_ratio", 1)))
            self.viewport = (pw, ph, ratio)
            # Under "publisher" (default) this stays informational — the publisher owns the
            # render size. Under "match_client" it becomes the target the render loop follows.
            if self._display.resize_policy == "match_client":
                self._display._request_target(pw, ph, ratio)
        self._display._enqueue_event(self.client_id, self.principal, event)
