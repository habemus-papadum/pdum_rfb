"""Transport seam between :class:`~pdum.rfb.session.RfbSession` and the socket.

The session is deliberately ignorant of *how* bytes move: it only needs to
``await send(...)`` and ``async for`` over inbound messages. :class:`Channel`
captures exactly that surface, and :class:`WebSocketTransport` adapts a
``websockets`` connection to it.

This is the additive seam behind roadmap §3: a future ``WebTransport`` or a
Starlette/ASGI ``WebSocket`` adapter (mapping ``WebSocketDisconnect`` onto the
``ConnectionClosed`` type the session already catches) is a drop-in here, with no
change to the session, encoders, or sources.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Protocol, runtime_checkable


@runtime_checkable
class Channel(Protocol):
    """The minimal duplex byte/text channel the session drives."""

    async def send(self, data: bytes | str) -> None:
        """Send one binary payload or one text control message."""
        ...

    def __aiter__(self) -> AsyncIterator[bytes | str]:
        """Asynchronously iterate inbound messages (``bytes`` or ``str``)."""
        ...


class WebSocketTransport:
    """Adapt a ``websockets`` server connection to the :class:`Channel` surface.

    A raw ``websockets`` connection already satisfies :class:`Channel`; this thin
    wrapper exists as the documented seam (and one place to translate disconnect
    semantics for non-``websockets`` transports later).
    """

    __slots__ = ("_ws",)

    def __init__(self, ws: Any) -> None:
        self._ws = ws

    async def send(self, data: bytes | str) -> None:
        await self._ws.send(data)

    def __aiter__(self) -> AsyncIterator[bytes | str]:
        return self._ws.__aiter__()

    async def close(self, code: int = 1000, reason: str = "") -> None:
        await self._ws.close(code, reason)
