"""WebSocket server + demo CLI for the push-model remote framebuffer.

:func:`serve` starts a ``websockets`` server **in the background** and returns a
live :class:`~pdum.rfb.display.Display`. The application owns its loop and pushes
frames with :meth:`Display.publish`; each connecting browser is negotiated a
transport and driven by its own :class:`~pdum.rfb.session.RfbSession`, all fed from
the display's latest frame.

The same port answers a small HTTP side channel used by the headless e2e harness:

* ``GET /health`` -> ``ok`` (readiness probe for Playwright's ``webServer``)
* ``GET /recorded-events`` -> JSON list of every input event received
* ``GET /recorded-events/reset`` -> clears the list (per-test isolation)
* ``GET /metrics`` -> JSON array, one object per active session

``python -m pdum.rfb.server`` is a self-contained demo: it owns a publish loop
streaming a deterministic pattern so a browser (or Playwright) can connect.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from http import HTTPStatus
from pathlib import Path
from typing import Any
from uuid import uuid4

from .adaptive import AdaptiveQualityController
from .auth import AuthContext, Authenticator
from .display import Display, _ClientFeed
from .encoders.base import build_encoder
from .protocol import UnsupportedClient, config_message, parse_control, select_transport
from .session import RfbSession
from .transport import WebSocketTransport


def _h264_importable() -> bool:
    import importlib.util

    return importlib.util.find_spec("av") is not None


def _nvenc_usable() -> bool:
    """True if a hardware NVENC H.264 encoder is available on this host."""
    try:
        from .encoders.nvenc_cpu import nvenc_cpu_available

        return nvenc_cpu_available()
    except Exception:  # pragma: no cover - defensive (e.g. av not installed)
        return False


#: The stream a client reaches with no URL path (``ws://host`` / ``ws://host/``).
DEFAULT_STREAM = "default"


async def _close_feed_on_disconnect(conn: Any, feed: _ClientFeed) -> None:
    """Stop ``feed`` when the socket closes, so a parked encode loop unparks.

    Without this, a client that disconnects while its session is idle (parked in
    ``next_frame`` waiting for the next publish) would never wake, and the
    session's ``TaskGroup`` would not complete. ``conn`` is any connection adapter
    exposing ``wait_closed()`` (see :class:`_WsConn` / the ASGI adapter).
    """
    try:
        await conn.wait_closed()
    finally:
        feed.close()


class _WsConn(WebSocketTransport):
    """Adapt a ``websockets`` server connection to the surface a connection lifecycle
    needs: the session :class:`~pdum.rfb.transport.Channel` (``send`` / ``__aiter__``
    / ``close``, inherited) **plus** ``recv`` (the initial hello), ``wait_closed``,
    and ``auth_fields`` (handshake metadata for :class:`AuthContext`).

    This is the seam that lets :meth:`_StreamHost._serve_connection` be
    transport-neutral: the ASGI adapter implements the same surface over a Starlette
    WebSocket, translating ``WebSocketDisconnect`` onto the ``ConnectionClosed`` the
    session already handles.
    """

    __slots__ = ()

    async def recv(self) -> Any:
        return await self._ws.recv()

    async def wait_closed(self) -> None:
        await self._ws.wait_closed()

    def auth_fields(self) -> dict:
        req = getattr(self._ws, "request", None)
        return {
            "headers": getattr(req, "headers", None),
            "path": getattr(req, "path", None),
            "remote": getattr(self._ws, "remote_address", None),
        }


class _StreamHost:
    """One named stream: a :class:`Display` plus its per-connection encode config.

    Negotiates a transport, authenticates, and drives one
    :class:`~pdum.rfb.session.RfbSession` per connecting viewer. A :class:`Server`
    owns the shared listener and routes each connection to the right ``_StreamHost``
    by URL path; with a single ``"default"`` stream this is exactly the old
    one-display ``serve()`` behaviour.
    """

    def __init__(
        self,
        display: Display,
        name: str = DEFAULT_STREAM,
        *,
        has_h264: bool | None = None,
        has_nvenc: bool | None = None,
        fps: int = 30,
        bitrate: int = 12_000_000,
        max_inflight: int = 2,
        adaptive: bool = False,
        still_after: float | None = None,
        stats_interval: float | None = None,
        authenticate: Authenticator | None = None,
        gpu: bool = False,
    ) -> None:
        self.display = display
        self.name = name
        self.has_h264 = _h264_importable() if has_h264 is None else has_h264
        # Prefer the GPU encoder when available. Auto-detect unless forced, and
        # never enable it when H.264 is disabled altogether (e.g. --force-image).
        if has_nvenc is None:
            self.has_nvenc = _nvenc_usable() if self.has_h264 else False
        else:
            self.has_nvenc = has_nvenc and self.has_h264
        # GPU encode is opt-in (gpu=True) and validated up front: the publisher pushes
        # CUDA frames and every viewer's H.264 encoder reads them directly. Two
        # backends, preferred in this order:
        #   1. nvenc_gpu_pdum  — habemus-papadum-nvenc (pdum.nvenc); PyAV-free, fastest;
        #   2. nvenc_gpu_pyav — zero-copy via PyAV >= 18 (needs the PyAV-18 stack).
        self.gpu = bool(gpu)
        if self.gpu:
            from .encoders.nvenc_gpu_pdum import nvenc_gpu_pdum_available

            if nvenc_gpu_pdum_available():
                # The SDK provides the H.264 transport itself, so it does not need
                # PyAV — flip has_h264 on so select_transport offers H.264 either way.
                self.has_h264 = True
                self.has_nvenc = True
                self.video_encoder = "nvenc_gpu_pdum"
            else:
                from .gpu import cuda_zerocopy_available

                if not (self.has_h264 and cuda_zerocopy_available()):
                    raise RuntimeError(
                        "gpu=True but no usable GPU encoder. Install either "
                        "habemus-papadum-nvenc (pip install 'habemus-papadum-rfb[gpu-nvenc-sdk]') "
                        "or CuPy + an NVENC GPU + PyAV >= 18 (call "
                        "pdum.rfb.gpu.enable_cuda_context_sharing() before any CuPy use). "
                        "See pdum.rfb.encoders.nvenc_gpu_pdum.nvenc_gpu_pdum_available(), "
                        "pdum.rfb.gpu.cuda_zerocopy_available(), and docs/gpu_zerocopy.md."
                    )
                self.has_nvenc = True
                self.video_encoder = "nvenc_gpu_pyav"
        else:
            self.video_encoder = "nvenc_cpu" if self.has_nvenc else "h264_cpu"
        self.fps = fps
        self.bitrate = bitrate
        self.max_inflight = max_inflight
        self.adaptive = adaptive
        self.still_after = still_after
        self.stats_interval = stats_interval
        self.authenticate = authenticate

    async def handler(self, connection: Any) -> None:
        """Drive one ``websockets`` connection (the standalone ``serve()`` path)."""
        await self._serve_connection(_WsConn(connection))

    async def _serve_connection(self, conn: Any) -> None:
        """Negotiate, authenticate, and run one session over any connection adapter.

        Transport-neutral: ``conn`` is a :class:`_WsConn` for the standalone
        ``websockets`` listener or the ASGI adapter for a Starlette WebSocket. Both
        expose ``recv`` / ``send`` / ``close`` / ``wait_closed`` / ``auth_fields``
        and are the session's :class:`~pdum.rfb.transport.Channel`. The adapters
        raise the ``ConnectionClosed`` the session already handles, so this body is
        identical for both front-ends.
        """
        import websockets

        try:
            hello = parse_control(await conn.recv())

            principal = await self._authenticate(conn, hello)
            if principal is _REJECTED:
                await conn.close(4401, "unauthorized")
                return

            supported = hello.get("supported", [])
            try:
                selection = select_transport(supported, has_h264=self.has_h264, has_nvenc=self.has_nvenc)
            except UnsupportedClient:
                await conn.close(1003, "no supported transport")
                return

            client_id = uuid4().hex
            feed = self.display._make_feed(client_id, principal)
            width, height = self.display.width, self.display.height

            def factory(w: int, h: int, bitrate: int, fps: int):
                encoder = build_encoder(
                    selection,
                    width=w,
                    height=h,
                    fps=fps,
                    bitrate=bitrate,
                    video_encoder=self.video_encoder,
                )
                # In GPU mode the publisher pushes CUDA frames; an image-transport
                # viewer's host encoder is wrapped so those frames are downloaded.
                if self.gpu and selection.transport == "image":
                    from .gpu import HostFrameAdapter

                    encoder = HostFrameAdapter(encoder)
                return encoder

            encoder = factory(width, height, self.bitrate, self.fps)
            transport = "webcodecs" if selection.transport == "h264" else "image"
            await conn.send(config_message(transport=transport, width=width, height=height, codec=selection.codec))

            controller = (
                AdaptiveQualityController(
                    max_bitrate=self.bitrate,
                    bitrate=self.bitrate,
                    max_inflight=self.max_inflight,
                    inflight=self.max_inflight,
                    max_fps=self.fps,
                    fps=self.fps,
                )
                if self.adaptive
                else None
            )
            session = RfbSession(
                feed,
                encoder,
                conn,
                encoder_factory=factory,
                max_inflight=self.max_inflight,
                bitrate=self.bitrate,
                fps=self.fps,
                adaptive=controller,
                still_after=self.still_after,
                stats_interval=self.stats_interval,
            )
            self.display._register_session(session)
            closer = asyncio.create_task(_close_feed_on_disconnect(conn, feed))
            try:
                await session.run()
            finally:
                closer.cancel()
                self.display._remove(client_id, feed, session)
        except websockets.ConnectionClosed:
            pass

    async def _authenticate(self, conn: Any, hello: dict) -> Any:
        """Return the principal, ``None`` (anonymous), or ``_REJECTED``."""
        if self.authenticate is None:
            return None
        fields = conn.auth_fields()
        ctx = AuthContext(
            token=hello.get("token"),
            headers=fields.get("headers"),
            cookies=fields.get("cookies"),
            path=fields.get("path"),
            query=fields.get("query"),
            remote=fields.get("remote"),
            hello=hello,
            stream=self.name,
        )
        try:
            principal = await self.authenticate(ctx)
        except Exception:
            return _REJECTED
        return _REJECTED if principal is None else principal

    def info(self) -> dict:
        """A one-line summary for the ``GET /streams`` listing."""
        return {
            "name": self.name,
            "width": self.display.width,
            "height": self.display.height,
            "fps": self.display.fps,
            "clients": self.display.client_count,
        }

    def metrics(self) -> list[dict]:
        """Per-session metric snapshots for this stream (``GET /streams/<name>/metrics``)."""
        return [s.metrics_snapshot() for s in self.display._sessions]


#: Sentinel distinguishing "authentication failed" from an anonymous ``None``.
_REJECTED = object()


class Server:
    """A hub: one WebSocket listener fronting several named streams.

    Each stream is an independent :class:`~pdum.rfb.display.Display` with its own
    encoder config; a browser selects one by **URL path** (``ws://host/<stream>``),
    and a connection with no path lands on the ``"default"`` stream. Streams are
    discoverable over HTTP at ``GET /streams``.

    Build one with :func:`serve_server`, or use :func:`serve` for the common
    single-default-stream case (it returns the default ``Display`` and keeps
    ``display.server`` pointing back here so you can ``add_stream`` more).

    This composes with everything else — multi-client fan-out, per-client
    backpressure, the encoders, auth, "still after settle" — none of which changes;
    a stream is just a ``Display`` plus its config, and routing is purely additive.
    """

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = 8765,
        origins: list[str | None] | None = None,
    ) -> None:
        self.host = host
        self._port = port  # requested; the bound port may differ when port=0
        self.origins = origins
        self._streams: dict[str, _StreamHost] = {}
        self._listener: Any = None
        self._listener_cm: Any = None
        self._closed = False

    # --- streams -----------------------------------------------------------

    def add_stream(
        self,
        name: str,
        width: int,
        height: int,
        *,
        fps: int = 30,
        bitrate: int = 12_000_000,
        max_inflight: int = 2,
        has_h264: bool | None = None,
        has_nvenc: bool | None = None,
        gpu: bool = False,
        adaptive: bool = False,
        still_after: float | None = None,
        stats_interval: float | None = None,
        authenticate: Authenticator | None = None,
        record_events: bool = False,
        event_log: str | Path | None = None,
        event_queue_size: int = 4096,
    ) -> Display:
        """Register a new named stream and return its :class:`Display`.

        Streams are independent: each carries its own encoder config (one GPU, one
        image; per-stream bitrate; per-stream ``authenticate``). Safe to call before
        or after :meth:`start` — clients reach it at ``ws://host/<name>`` either way.
        Raises if ``name`` is already taken.
        """
        if name in self._streams:
            raise ValueError(f"stream {name!r} already exists")
        display = Display(
            width,
            height,
            fps=fps,
            record_events=record_events,
            event_log=event_log,
            event_queue_size=event_queue_size,
        )
        host = _StreamHost(
            display,
            name,
            has_h264=has_h264,
            has_nvenc=has_nvenc,
            fps=fps,
            bitrate=bitrate,
            max_inflight=max_inflight,
            adaptive=adaptive,
            still_after=still_after,
            stats_interval=stats_interval,
            authenticate=authenticate,
            gpu=gpu,
        )
        self._streams[name] = host
        display._owner_server = self
        display._server = self._listener  # None until start(); back-filled there
        return display

    def stream(self, name: str = DEFAULT_STREAM) -> Display:
        """Return the :class:`Display` for stream ``name`` (``KeyError`` if absent)."""
        return self._streams[name].display

    @property
    def streams(self) -> list[str]:
        """The names of the registered streams."""
        return list(self._streams)

    @property
    def port(self) -> int | None:
        """The bound TCP port (the actual one when started with ``port=0``)."""
        if self._listener is not None:
            return next(iter(self._listener.sockets)).getsockname()[1]
        return self._port

    # --- lifecycle ---------------------------------------------------------

    async def start(self) -> Server:
        """Start the shared listener in the background; returns ``self``."""
        import websockets.asyncio.server

        kwargs: dict[str, Any] = dict(process_request=self.process_request, max_size=None)
        if self.origins is not None:
            kwargs["origins"] = self.origins
        cm = websockets.asyncio.server.serve(self._route, self.host, self._port, **kwargs)
        self._listener = await cm.__aenter__()
        self._listener_cm = cm
        for host in self._streams.values():
            host.display._server = self._listener
        return self

    async def aclose(self) -> None:
        """Stop the listener and disconnect every viewer of every stream."""
        if self._closed:
            return
        self._closed = True
        if self._listener_cm is not None:
            cm, self._listener_cm = self._listener_cm, None
            self._listener = None
            await cm.__aexit__(None, None, None)
        for host in self._streams.values():
            host.display._close_local()

    async def __aenter__(self) -> Server:
        return await self.start()

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    # --- routing -----------------------------------------------------------

    @staticmethod
    def _stream_name(path: str) -> str:
        """Map a request path to a stream name (first path segment; ``"default"``)."""
        seg = path.split("?", 1)[0].strip("/").split("/", 1)[0]
        return seg or DEFAULT_STREAM

    async def _route(self, connection: Any) -> None:
        """Dispatch one connection to its stream by URL path (close 4404 if unknown)."""
        req = getattr(connection, "request", None)
        name = self._stream_name(getattr(req, "path", "") or "")
        host = self._streams.get(name)
        if host is None:
            await connection.close(4404, f"unknown stream {name!r}")
            return
        await host.handler(connection)

    def process_request(self, connection: Any, request: Any):
        """Answer the HTTP side-channel routes; return None to proceed with WS.

        Global: ``GET /health``, ``GET /streams``, ``GET /streams/<name>/metrics``.
        For backward compatibility the single-stream routes (``/metrics``,
        ``/recorded-events``, ``/recorded-events/reset``) act on the ``"default"``
        stream when one exists.
        """
        path = request.path.split("?", 1)[0]
        if path == "/health":
            return connection.respond(HTTPStatus.OK, "ok\n")
        if path == "/streams":
            return connection.respond(HTTPStatus.OK, json.dumps([h.info() for h in self._streams.values()]))
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "streams" and parts[2] == "metrics":
            host = self._streams.get(parts[1])
            if host is None:
                return connection.respond(HTTPStatus.NOT_FOUND, "[]")
            return connection.respond(HTTPStatus.OK, json.dumps(host.metrics()))
        default = self._streams.get(DEFAULT_STREAM)
        if default is not None:
            if path == "/metrics":
                return connection.respond(HTTPStatus.OK, json.dumps(default.metrics()))
            if path == "/recorded-events":
                return connection.respond(HTTPStatus.OK, json.dumps(default.display.recorded))
            if path == "/recorded-events/reset":
                default.display.recorded.clear()
                return connection.respond(HTTPStatus.OK, "[]")
        return None


async def serve(
    width: int,
    height: int,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    fps: int = 30,
    bitrate: int = 12_000_000,
    max_inflight: int = 2,
    has_h264: bool | None = None,
    has_nvenc: bool | None = None,
    gpu: bool = False,
    adaptive: bool = False,
    still_after: float | None = None,
    stats_interval: float | None = None,
    authenticate: Authenticator | None = None,
    origins: list[str | None] | None = None,
    record_events: bool = False,
    event_log: str | Path | None = None,
    event_queue_size: int = 4096,
) -> Display:
    """Start the RFB WebSocket server in the background and return a :class:`Display`.

    You own your loop: ``display = await serve(w, h, port=...)`` then call
    ``display.publish(frame)`` whenever you like, and ``await display.aclose()`` to
    shut down.

    Parameters
    ----------
    width, height:
        Initial framebuffer size (a connecting client is configured to the
        display's current size; publish a different shape to resize).
    has_h264, has_nvenc:
        ``None`` auto-detects; ``False`` forces the CPU/image fallback. ``has_nvenc``
        selects the GPU encoder when an NVENC-capable device is present.
    gpu:
        Opt in to **GPU encode**: the publisher pushes CUDA frames (CuPy/DLPack NV12
        or rgb) and each viewer's H.264 encoder reads them directly, no host copy.
        Prefers the **PyAV-free NVENC SDK** backend (``habemus-papadum-nvenc``) when
        available, else the **zero-copy CUDA→NVENC** backend (PyAV >= 18). Validated
        at startup; raises if neither is usable. For the PyAV-18 path, call
        :func:`pdum.rfb.gpu.enable_cuda_context_sharing` before any CuPy use.
    still_after:
        Opt in to **"still after interaction settles"**: when no new frame is
        published for ``still_after`` seconds (e.g. ``0.15``), each viewer is sent a
        high-quality still of the resting frame — a **lossless PNG** on the image
        path, a clean **IDR** on the video path — so the settled image is crisp even
        though the live stream is lossy. ``None`` (default) disables it. See
        ``docs/still_after_settle.md``.
    adaptive:
        Enable adaptive quality (bitrate → fps → in-flight, with recovery): the
        encoder is rebuilt as the controller reacts to the client's decode-queue
        depth and RTT. Pairs well with ``stats_interval`` so the browser can show it.
    stats_interval:
        Opt in to a periodic server→client ``stats`` control message (seconds, e.g.
        ``1.0``) carrying authoritative server metrics — RTT, fps, bitrate, encode
        time, and the adaptive targets — so the browser can surface them in its
        ``Stats``. ``None`` (default) sends none.
    authenticate:
        Optional async hook (see :mod:`pdum.rfb.auth`); rejected connections are
        closed with code ``4401`` before any frame is sent.
    origins:
        Allowed ``Origin`` values (CSWSH defense) passed to ``websockets``.

    Notes
    -----
    This hosts a single ``"default"`` stream. Reach the hub behind it via
    ``display.server`` to host **several** streams from the one port
    (``display.server.add_stream("camera_b", 640, 480)``), or start with
    :func:`serve_server` for a hub with no default stream. See
    ``docs/multiple_streams.md``.
    """
    server = Server(host=host, port=port, origins=origins)
    display = server.add_stream(
        DEFAULT_STREAM,
        width,
        height,
        fps=fps,
        bitrate=bitrate,
        max_inflight=max_inflight,
        has_h264=has_h264,
        has_nvenc=has_nvenc,
        gpu=gpu,
        adaptive=adaptive,
        still_after=still_after,
        stats_interval=stats_interval,
        authenticate=authenticate,
        record_events=record_events,
        event_log=event_log,
        event_queue_size=event_queue_size,
    )
    await server.start()
    # The one-liner contract: closing the returned Display tears down the whole hub.
    display._server_cm = server
    return display


async def serve_server(
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    origins: list[str | None] | None = None,
    streams: list[dict[str, Any]] | None = None,
) -> Server:
    """Start a **multi-stream hub** and return the :class:`Server`.

    Unlike :func:`serve` (one default stream, returns its ``Display``), this returns
    the hub itself with no default stream. Add streams with
    ``server.add_stream(name, w, h, **config)`` — each returns its own ``Display`` to
    publish into — and clients attach by URL path (``ws://host/<name>``). A client
    with no path is rejected until a ``"default"`` stream exists.

    Parameters
    ----------
    host, port, origins:
        As for :func:`serve` — they configure the one shared listener.
    streams:
        Optional list of ``add_stream`` keyword dicts to register **before** the
        listener starts (atomic setup), e.g.
        ``[{"name": "rgb", "width": 1280, "height": 720, "gpu": True}]``. You can
        also add streams afterwards.

    Examples
    --------
    >>> server = await serve_server(port=8765)
    >>> cam = server.add_stream("camera", 1280, 720)
    >>> depth = server.add_stream("depth", 640, 480, has_h264=False)
    >>> cam.publish(render_camera()); depth.publish(render_depth())
    >>> await server.aclose()
    """
    server = Server(host=host, port=port, origins=origins)
    for spec in streams or []:
        server.add_stream(**spec)
    await server.start()
    return server


async def _amain(args: argparse.Namespace) -> None:
    from .testing import render_pattern

    w = args.width - (args.width % 2)
    h = args.height - (args.height % 2)
    display = await serve(
        w,
        h,
        host=args.host,
        port=args.port,
        fps=args.fps,
        bitrate=args.bitrate,
        has_h264=False if args.force_image else None,
        has_nvenc=False if args.no_nvenc else None,
        gpu=args.gpu,
        adaptive=args.adaptive,
        still_after=args.still_after,
        stats_interval=args.stats_interval,
        record_events=args.record_events,
        event_log=args.event_log,
    )

    # In --gpu mode the demo uploads each pattern frame to the GPU so the
    # zero-copy CUDA→NVENC path is actually exercised end-to-end.
    to_device = None
    if args.gpu:
        import cupy as cp

        to_device = cp.asarray

    if args.gpu:
        encoder = "h264/nvenc-cuda (GPU zero-copy)"
    elif args.force_image:
        encoder = "image"
    elif not args.no_nvenc and _nvenc_usable():
        encoder = "h264/nvenc (GPU)"
    elif _h264_importable():
        encoder = "h264/libx264 (CPU)"
    else:
        encoder = "image"
    print(f"RFB server on ws://{args.host}:{args.port}  (pattern={args.pattern}, encoder={encoder})")

    seq = 0
    try:
        while args.max_frames is None or seq < args.max_frames:
            for _ev in display.poll_events():
                pass  # the demo ignores input; --record-events captures it via the Display log
            frame = render_pattern(args.pattern, seq, w, h)
            display.publish(to_device(frame) if to_device is not None else frame)
            seq += 1
            await asyncio.sleep(1 / args.fps)
    finally:
        await display.aclose()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Remote framebuffer demo/test server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--bitrate", type=int, default=12_000_000)
    parser.add_argument(
        "--pattern",
        default="bouncing_box",
        choices=["test_card", "gradient", "bouncing_box", "counter", "checkerboard", "solid"],
    )
    parser.add_argument("--test-pattern", dest="pattern", action="store_const", const="test_card")
    parser.add_argument("--force-image", action="store_true", help="ignore H.264 even if available")
    parser.add_argument("--no-nvenc", action="store_true", help="disable the GPU NVENC encoder (use CPU libx264)")
    parser.add_argument(
        "--gpu",
        action="store_true",
        help="zero-copy CUDA→NVENC: upload pattern frames to the GPU and encode them directly (needs CuPy + PyAV>=18)",
    )
    parser.add_argument("--adaptive", action="store_true", help="enable adaptive bitrate/fps/backpressure")
    parser.add_argument(
        "--stats-interval",
        type=float,
        default=None,
        metavar="SECONDS",
        help="push server-truth stats (RTT/fps/bitrate) to the client every N seconds (e.g. 1.0)",
    )
    parser.add_argument(
        "--still-after",
        type=float,
        default=None,
        metavar="SECONDS",
        help="send a lossless PNG / clean IDR still this many seconds after frames settle (e.g. 0.15)",
    )
    parser.add_argument("--record-events", action="store_true")
    parser.add_argument("--event-log", default=None)
    parser.add_argument("--max-frames", type=int, default=None)
    args = parser.parse_args(argv)

    try:
        asyncio.run(_amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
