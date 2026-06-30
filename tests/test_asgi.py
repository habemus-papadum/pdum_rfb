"""Tests for the opt-in ASGI / Starlette front-end (`pdum.rfb.asgi`).

Drives the same Display/RfbSession core over a Starlette WebSocket via Starlette's
in-process ``TestClient`` (the ASGI server owns the loop, so the publish loop runs
from a lifespan handler — the real usage shape). Skipped if Starlette is absent.
"""

import contextlib
import time

import numpy as np
import pytest

starlette = pytest.importorskip("starlette")

from starlette.applications import Starlette  # noqa: E402
from starlette.routing import WebSocketRoute  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import pdum.rfb as rfb  # noqa: E402
from pdum.rfb.asgi import rfb_endpoint, rfb_hub_endpoint  # noqa: E402

HELLO = {"type": "hello", "supported": ["image/jpeg", "image/png"], "device_pixel_ratio": 1}


def _frame(value=128, w=64, h=48):
    return np.full((h, w, 3), value, dtype=np.uint8)


def _lifespan_publishing(*displays_and_frames):
    """A lifespan that publishes one frame into each display at startup."""

    @contextlib.asynccontextmanager
    async def lifespan(app):
        for display, frame in displays_and_frames:
            display.publish(frame)
        yield

    return lifespan


def test_asgi_handshake_and_frame_and_event():
    display = rfb.Display(64, 48, record_events=True)
    app = Starlette(
        lifespan=_lifespan_publishing((display, _frame(200, 64, 48))),
        routes=[WebSocketRoute("/rfb", rfb_endpoint(display, has_h264=False))],
    )
    with TestClient(app) as client:
        with client.websocket_connect("/rfb") as ws:
            ws.send_json(HELLO)
            config = ws.receive_json()
            assert config["type"] == "config"
            assert config["transport"] == "image"
            assert config["width"] == 64 and config["height"] == 48

            payload = ws.receive_bytes()
            assert isinstance(payload, (bytes, bytearray)) and len(payload) > 0

            ws.send_json({"type": "event", "event": {"type": "pointer_down", "x": 3, "y": 4}})
            for _ in range(100):
                if display.recorded:
                    break
                time.sleep(0.02)
    assert any(e["type"] == "pointer_down" for e in display.recorded)


def test_asgi_auth_uses_request_cookie():
    async def authenticate(ctx):
        # Same-origin cookie auth: the hook reads the host app's session cookie.
        return {"u": "alice"} if ctx.cookies.get("session") == "good" else None

    display = rfb.Display(32, 24)
    app = Starlette(
        lifespan=_lifespan_publishing((display, _frame(10, 32, 24))),
        routes=[WebSocketRoute("/rfb", rfb_endpoint(display, has_h264=False, authenticate=authenticate))],
    )
    with TestClient(app) as client:
        # Good cookie -> accepted, gets a config.
        with client.websocket_connect("/rfb", headers={"cookie": "session=good"}) as ws:
            ws.send_json(HELLO)
            assert ws.receive_json()["type"] == "config"

        # No cookie -> rejected with the app auth code 4401.
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/rfb") as ws:
                ws.send_json(HELLO)
                ws.receive_json()
        assert exc.value.code == 4401


def test_asgi_hub_endpoint_routes_by_path_param():
    server = rfb.Server()  # not started: no listener, just a stream registry
    cam = server.add_stream("cam", 64, 48, has_h264=False)
    depth = server.add_stream("depth", 32, 24, has_h264=False)
    app = Starlette(
        lifespan=_lifespan_publishing((cam, _frame(200, 64, 48)), (depth, _frame(50, 32, 24))),
        routes=[WebSocketRoute("/rfb/{stream}", rfb_hub_endpoint(server))],
    )
    with TestClient(app) as client:
        with client.websocket_connect("/rfb/cam") as ws:
            ws.send_json(HELLO)
            assert ws.receive_json()["width"] == 64
        with client.websocket_connect("/rfb/depth") as ws:
            ws.send_json(HELLO)
            assert ws.receive_json()["width"] == 32

        # Unknown stream -> closed with 4404.
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/rfb/missing") as ws:
                ws.receive_json()
        assert exc.value.code == 4404
