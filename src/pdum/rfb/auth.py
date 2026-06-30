"""Pluggable authentication seam (deliberately thin).

The library ships **only** the hook signature and the context/identity types — it
never depends on a JWT/JWKS library and has no opinion on *how* you authenticate.
You pass an ``authenticate`` callable to :func:`pdum.rfb.serve`; it is invoked once
per connection and returns an application-defined *principal* (any object) to
accept, or ``None`` to reject.

In v1 the credential arrives in the client's ``hello`` message
(``AuthContext.token``) because a browser ``WebSocket`` cannot set request headers.
The context also carries the handshake ``headers`` / ``path`` / ``query`` so a
future same-site-cookie or ASGI transport can feed the *same* hook without an API
change (at which point the ``hello`` token simply becomes optional).

Example — verify a Google OAuth ID token (your code; needs e.g. ``google-auth``)::

    from google.oauth2 import id_token
    from google.auth.transport import requests as g_requests

    ALLOWED = {"alice@example.com", "bob@example.com"}
    _req = g_requests.Request()

    async def authenticate(ctx):
        if not ctx.token:
            return None
        try:
            claims = id_token.verify_oauth2_token(ctx.token, _req, audience=CLIENT_ID)
        except ValueError:
            return None
        email = claims.get("email")
        return claims if email in ALLOWED else None

    display = await rfb.serve(1280, 720, authenticate=authenticate)
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

#: An application-defined identity returned by an :data:`Authenticator`. Treated
#: opaquely by the library and attached to every :class:`~pdum.rfb.types.InputEvent`.
Principal = Any


@dataclass(slots=True)
class AuthContext:
    """Everything the auth hook may inspect about a connecting client.

    Parameters
    ----------
    token:
        The credential from the client's ``hello`` message (v1 transport).
    headers:
        Handshake request headers (e.g. ``Cookie``), when the transport exposes
        them. ``None`` for the plain ``hello``-token path.
    cookies:
        Parsed request cookies, when the transport exposes them (e.g. the ASGI
        adapter) — the natural home for a same-origin session/OAuth cookie.
    path:
        Request path including query string, when available.
    query:
        Parsed query parameters, when available.
    remote:
        ``(host, port)`` of the peer, when available.
    hello:
        The full decoded ``hello`` dict, for transports that carry auth in-band.
    stream:
        Name of the stream (named :class:`~pdum.rfb.display.Display`) this client is
        connecting to, for per-stream authorization. ``"default"`` for the
        single-stream ``serve()`` path; the URL-path segment for a hub
        (``ws://host/<stream>``). See :func:`pdum.rfb.serve_server`.
    """

    token: str | None = None
    headers: Mapping[str, str] | None = None
    cookies: Mapping[str, str] | None = None
    path: str | None = None
    query: Mapping[str, str] | None = None
    remote: tuple[str, int] | None = None
    hello: dict | None = None
    stream: str | None = None


#: Async hook: given an :class:`AuthContext`, return a :data:`Principal` to accept
#: the connection or ``None`` to reject it. Raising is treated as a rejection.
Authenticator = Callable[[AuthContext], Awaitable[Principal | None]]
