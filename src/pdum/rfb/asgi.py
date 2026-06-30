"""ASGI / Starlette front-end: mount the framebuffer inside an existing app.

Opt-in (``pip install habemus-papadum-rfb[asgi]``) and **additive**: a *second*
front-end over the exact same :class:`~pdum.rfb.display.Display` /
:class:`~pdum.rfb.session.RfbSession` core as :func:`pdum.rfb.serve`. The standalone
``serve()`` path (with its zero-extra-deps ``websockets`` listener) is unchanged —
this just lets you reach the same machinery through Starlette/FastAPI when you want
**same-origin** hosting: shared TLS, routing, and the app's session/OAuth **cookie**
(the auth hook receives ``AuthContext.cookies`` / ``.headers``).

Because the ASGI server owns the event loop, the usage shape is: create your
``Display`` (or :class:`~pdum.rfb.server.Server` hub) at app startup, run your publish
loop as a background task (e.g. from a lifespan handler), and mount one of the
endpoints below. This module only adds the WebSocket endpoint that drives one
``RfbSession`` per connection.

Example (Starlette)::

    import asyncio, contextlib, pdum.rfb as rfb
    from pdum.rfb.asgi import rfb_endpoint
    from starlette.applications import Starlette
    from starlette.routing import WebSocketRoute

    display = rfb.Display(1280, 720)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        async def publish_loop():
            while True:
                display.publish(render())
                await asyncio.sleep(1 / 30)
        task = asyncio.create_task(publish_loop())
        yield
        task.cancel()

    app = Starlette(lifespan=lifespan, routes=[
        WebSocketRoute("/rfb", rfb_endpoint(display, authenticate=my_cookie_auth)),
    ])

For several streams, mount :func:`rfb_hub_endpoint` on a path that captures a
``{stream}`` parameter.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from .auth import Authenticator
from .display import Display
from .server import DEFAULT_STREAM, Server, _StreamHost

Endpoint = Callable[[Any], Any]


class _AsgiConn:
    """Adapt a Starlette ``WebSocket`` to the connection surface the session core
    drives, translating ``WebSocketDisconnect`` onto the ``ConnectionClosed``
    semantics :class:`~pdum.rfb.session.RfbSession` and ``_StreamHost`` already
    handle: a receive-side disconnect ends iteration; a send-side disconnect raises
    ``websockets.ConnectionClosedOK`` (always installed). Mirrors
    :class:`pdum.rfb.server._WsConn`.
    """

    __slots__ = ("_ws", "_closed")

    def __init__(self, websocket: Any) -> None:
        self._ws = websocket
        self._closed = asyncio.Event()

    async def _receive(self) -> bytes | str | None:
        """Return the next inbound message, or ``None`` on disconnect."""
        message = await self._ws.receive()
        if message["type"] == "websocket.disconnect":
            self._closed.set()
            return None
        text = message.get("text")
        return text if text is not None else message.get("bytes")

    async def recv(self) -> bytes | str:
        data = await self._receive()
        if data is None:
            from websockets.exceptions import ConnectionClosedOK

            raise ConnectionClosedOK(None, None)
        return data

    def __aiter__(self) -> _AsgiConn:
        return self

    async def __anext__(self) -> bytes | str:
        data = await self._receive()
        if data is None:
            raise StopAsyncIteration
        return data

    async def send(self, data: bytes | str) -> None:
        try:
            if isinstance(data, (bytes, bytearray)):
                await self._ws.send_bytes(bytes(data))
            else:
                await self._ws.send_text(data)
        except Exception as exc:  # client vanished mid-send; end the session cleanly
            self._closed.set()
            from websockets.exceptions import ConnectionClosedOK

            raise ConnectionClosedOK(None, None) from exc

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self._closed.set()
        try:
            await self._ws.close(code, reason or None)
        except Exception:  # already closing / closed
            pass

    async def wait_closed(self) -> None:
        await self._closed.wait()

    def auth_fields(self) -> dict:
        ws = self._ws
        client = getattr(ws, "client", None)
        return {
            "headers": dict(ws.headers),
            "cookies": dict(ws.cookies),
            "path": ws.url.path,
            "query": dict(ws.query_params),
            "remote": (client.host, client.port) if client else None,
        }


def _stream_host(
    display: Display,
    name: str,
    *,
    has_h264: bool | None,
    has_nvenc: bool | None,
    gpu: bool,
    bitrate: int,
    fps: int | None,
    max_inflight: int,
    adaptive: bool,
    still_after: float | None,
    stats_interval: float | None,
    authenticate: Authenticator | None,
) -> _StreamHost:
    return _StreamHost(
        display,
        name,
        has_h264=has_h264,
        has_nvenc=has_nvenc,
        fps=display.fps if fps is None else fps,
        bitrate=bitrate,
        max_inflight=max_inflight,
        adaptive=adaptive,
        still_after=still_after,
        stats_interval=stats_interval,
        authenticate=authenticate,
        gpu=gpu,
    )


def rfb_endpoint(
    display: Display,
    *,
    name: str = DEFAULT_STREAM,
    has_h264: bool | None = None,
    has_nvenc: bool | None = None,
    gpu: bool = False,
    bitrate: int = 12_000_000,
    fps: int | None = None,
    max_inflight: int = 2,
    adaptive: bool = False,
    still_after: float | None = None,
    stats_interval: float | None = None,
    authenticate: Authenticator | None = None,
) -> Endpoint:
    """Return a Starlette WebSocket endpoint that streams one :class:`Display`.

    Mount it on any path::

        app.add_websocket_route("/rfb", rfb_endpoint(display, authenticate=auth))

    The keyword config mirrors :func:`pdum.rfb.serve` (encoder/transport selection,
    ``gpu``, ``adaptive``, ``still_after``, per-endpoint ``authenticate``). ``fps``
    defaults to the display's. The ``authenticate`` hook receives an
    :class:`~pdum.rfb.auth.AuthContext` carrying the request ``cookies`` / ``headers``
    so it can reuse the host app's same-origin session.
    """
    host = _stream_host(
        display,
        name,
        has_h264=has_h264,
        has_nvenc=has_nvenc,
        gpu=gpu,
        bitrate=bitrate,
        fps=fps,
        max_inflight=max_inflight,
        adaptive=adaptive,
        still_after=still_after,
        stats_interval=stats_interval,
        authenticate=authenticate,
    )

    async def endpoint(websocket: Any) -> None:
        await websocket.accept()
        await host._serve_connection(_AsgiConn(websocket))

    return endpoint


def rfb_hub_endpoint(server: Server, *, param: str = "stream") -> Endpoint:
    """Return a Starlette endpoint routing to a :class:`Server` hub's streams.

    Mount it on a path that captures the stream name as a path parameter::

        app.add_websocket_route("/rfb/{stream}", rfb_hub_endpoint(server))

    The connection is routed to ``server``'s stream of that name (an unknown stream
    closes with application code ``4404``); a request without the parameter uses the
    ``"default"`` stream. The hub and its per-stream config (including per-stream
    ``authenticate``) are reused exactly as for the standalone listener.
    """

    async def endpoint(websocket: Any) -> None:
        stream_name = websocket.path_params.get(param, DEFAULT_STREAM)
        host = server._streams.get(stream_name)
        await websocket.accept()
        if host is None:
            await websocket.close(4404, f"unknown stream {stream_name!r}")
            return
        await host._serve_connection(_AsgiConn(websocket))

    return endpoint
