"""Real-socket integration tests of the push-model WebSocket server.

Exercises the full handshake (hello -> config -> binary frame) against a live
``serve()`` Display, event delivery into ``poll_events`` / the HTTP side channel,
multi-client fan-out, and the auth hook.
"""

import asyncio
import json
import urllib.request

import numpy as np
import pytest
import websockets.asyncio.client
import websockets.exceptions

from pdum.rfb import serve
from pdum.rfb.protocol import unpack_binary_message


def _frame(value=128, w=64, h=48):
    return np.full((h, w, 3), value, dtype=np.uint8)


async def _hello(ws, supported=("image/jpeg", "image/png"), token=None):
    msg = {"type": "hello", "supported": list(supported), "device_pixel_ratio": 1}
    if token is not None:
        msg["token"] = token
    await ws.send(json.dumps(msg))


async def _get(port, path):
    return await asyncio.to_thread(lambda: urllib.request.urlopen(f"http://127.0.0.1:{port}{path}").read())


async def test_handshake_event_and_side_channel():
    display = await serve(64, 48, port=0, has_h264=False, record_events=True)
    display.publish(_frame())
    port = display.port
    try:
        assert (await _get(port, "/health")).strip() == b"ok"

        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws:
            await _hello(ws)
            config = json.loads(await ws.recv())
            assert config["type"] == "config"
            assert config["transport"] == "image"
            assert config["width"] == 64 and config["height"] == 48

            msg = await ws.recv()
            assert isinstance(msg, (bytes, bytearray))
            header, payload = unpack_binary_message(msg)
            assert header["type"] == "image_frame" and header["seq"] == 0
            assert header["width"] == 64 and header["height"] == 48 and len(payload) > 0

            move = {"type": "pointer_move", "x": 5, "y": 6, "buttons": [1]}
            await ws.send(json.dumps({"type": "event", "event": move}))
            for _ in range(50):
                if display.recorded:
                    break
                await asyncio.sleep(0.02)

            metrics = json.loads(await _get(port, "/metrics"))
            assert len(metrics) == 1 and metrics[0]["frames_sent"] >= 1

        events = display.poll_events()
        assert any(e.event.get("type") == "pointer_move" for e in events)
        recorded = json.loads(await _get(port, "/recorded-events"))
        assert any(e.get("type") == "pointer_move" for e in recorded)
    finally:
        await display.aclose()


async def test_two_clients_share_one_display():
    display = await serve(32, 24, port=0, has_h264=False)
    display.publish(_frame(64, 32, 24))
    port = display.port
    try:
        async with (
            websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws1,
            websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws2,
        ):
            for ws in (ws1, ws2):
                await _hello(ws)
                assert json.loads(await ws.recv())["type"] == "config"
            # Both viewers receive a seq-0 keyframe of the same display.
            for ws in (ws1, ws2):
                header, payload = unpack_binary_message(await ws.recv())
                assert header["type"] == "image_frame" and header["seq"] == 0 and len(payload) > 0
            for _ in range(50):
                if display.client_count == 2:
                    break
                await asyncio.sleep(0.02)
            assert display.client_count == 2
    finally:
        await display.aclose()


async def test_auth_rejects_without_valid_token():
    async def authenticate(ctx):
        return {"sub": "u1"} if ctx.token == "good" else None

    display = await serve(32, 24, port=0, has_h264=False, authenticate=authenticate)
    display.publish(_frame(0, 32, 24))
    port = display.port
    try:
        # Bad token -> connection closed with the app auth code, no config.
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws:
            await _hello(ws, token="bad")
            with pytest.raises(websockets.exceptions.ConnectionClosed) as exc:
                await ws.recv()
            assert exc.value.rcvd.code == 4401

        # Good token -> principal flows onto the event stream.
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws:
            await _hello(ws, token="good")
            assert json.loads(await ws.recv())["type"] == "config"
            await ws.recv()  # keyframe
            await ws.send(json.dumps({"type": "event", "event": {"type": "pointer_down", "x": 1, "y": 1}}))
            for _ in range(50):
                evs = display.poll_events()
                if evs:
                    assert evs[0].principal == {"sub": "u1"}
                    break
                await asyncio.sleep(0.02)
            else:
                raise AssertionError("event with principal never arrived")
    finally:
        await display.aclose()
