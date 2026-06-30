"""Real-socket tests for the multi-stream hub (named displays).

Exercises URL-path routing to independent streams, the default stream, the REST
listing, per-stream metrics, unknown-stream rejection, per-stream auth context,
and the lifecycle wiring shared with single-stream ``serve()``.
"""

import asyncio
import json
import urllib.error
import urllib.request

import numpy as np
import pytest
import websockets.asyncio.client
import websockets.exceptions

from pdum.rfb import serve, serve_server


def _frame(value=128, w=64, h=48):
    return np.full((h, w, 3), value, dtype=np.uint8)


async def _hello(ws, supported=("image/jpeg", "image/png"), token=None):
    msg = {"type": "hello", "supported": list(supported), "device_pixel_ratio": 1}
    if token is not None:
        msg["token"] = token
    await ws.send(json.dumps(msg))


async def _get(port, path):
    def _fetch():
        return urllib.request.urlopen(f"http://127.0.0.1:{port}{path}").read()

    return await asyncio.to_thread(_fetch)


async def _config(ws):
    await _hello(ws)
    return json.loads(await ws.recv())


async def test_path_routes_to_independent_streams():
    server = await serve_server(port=0)
    cam = server.add_stream("cam", 64, 48, has_h264=False)
    depth = server.add_stream("depth", 32, 24, has_h264=False)
    cam.publish(_frame(200, 64, 48))
    depth.publish(_frame(50, 32, 24))
    port = server.port
    try:
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}/cam") as ws:
            cfg = await _config(ws)
            assert cfg["width"] == 64 and cfg["height"] == 48
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}/depth") as ws:
            cfg = await _config(ws)
            assert cfg["width"] == 32 and cfg["height"] == 24
    finally:
        await server.aclose()


async def test_no_path_uses_default_stream():
    server = await serve_server(port=0)
    server.add_stream("default", 80, 60, has_h264=False).publish(_frame(10, 80, 60))
    port = server.port
    try:
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws:
            cfg = await _config(ws)
            assert cfg["width"] == 80 and cfg["height"] == 60
    finally:
        await server.aclose()


async def test_unknown_stream_is_rejected():
    server = await serve_server(port=0)
    server.add_stream("only", 32, 24, has_h264=False)
    port = server.port
    try:
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}/missing") as ws:
            with pytest.raises(websockets.exceptions.ConnectionClosed) as exc:
                await ws.recv()
            assert exc.value.rcvd.code == 4404
    finally:
        await server.aclose()


async def test_streams_listing_and_per_stream_metrics():
    server = await serve_server(port=0)
    cam = server.add_stream("cam", 64, 48, has_h264=False)
    server.add_stream("depth", 32, 24, has_h264=False)
    cam.publish(_frame(200, 64, 48))
    port = server.port
    try:
        listing = {s["name"]: s for s in json.loads(await _get(port, "/streams"))}
        assert set(listing) == {"cam", "depth"}
        assert listing["cam"]["width"] == 64 and listing["cam"]["height"] == 48
        assert listing["depth"]["width"] == 32

        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}/cam") as ws:
            await _config(ws)
            await ws.recv()  # the seq-0 keyframe
            for _ in range(50):
                if cam.client_count == 1:
                    break
                await asyncio.sleep(0.02)
            assert cam.client_count == 1
            assert json.loads(await _get(port, "/streams"))[0]["clients"] >= 0  # listing stays valid
            metrics = json.loads(await _get(port, "/streams/cam/metrics"))
            assert len(metrics) == 1 and metrics[0]["frames_sent"] >= 1
            # An unknown stream's metrics 404s.
            with pytest.raises(urllib.error.HTTPError) as exc:
                await _get(port, "/streams/nope/metrics")
            assert exc.value.code == 404
    finally:
        await server.aclose()


async def test_auth_context_carries_stream_name():
    seen = {}

    async def authenticate(ctx):
        seen["stream"] = ctx.stream
        return {"ok": True} if ctx.token == "good" else None

    server = await serve_server(port=0)
    server.add_stream("camA", 32, 24, has_h264=False, authenticate=authenticate)
    port = server.port
    try:
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}/camA") as ws:
            await _hello(ws, token="good")
            assert json.loads(await ws.recv())["type"] == "config"
        assert seen["stream"] == "camA"
    finally:
        await server.aclose()


async def test_serve_returns_default_and_hub_hosts_more():
    # The serve() one-liner still works, and its hub can host extra streams.
    display = await serve(64, 48, port=0, has_h264=False)
    display.publish(_frame(99, 64, 48))
    extra = display.server.add_stream("extra", 32, 24, has_h264=False)
    extra.publish(_frame(1, 32, 24))
    port = display.port
    try:
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws:
            assert (await _config(ws))["width"] == 64
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}/extra") as ws:
            assert (await _config(ws))["width"] == 32
        names = {s["name"] for s in json.loads(await _get(port, "/streams"))}
        assert names == {"default", "extra"}
    finally:
        # Closing the returned Display tears down the whole hub (the one-liner contract).
        await display.aclose()

    # The listener is gone: a fresh connection now fails.
    with pytest.raises((OSError, websockets.exceptions.WebSocketException)):
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.recv()


async def test_duplicate_stream_name_raises():
    server = await serve_server(port=0)
    server.add_stream("a", 32, 24, has_h264=False)
    try:
        with pytest.raises(ValueError):
            server.add_stream("a", 16, 16, has_h264=False)
    finally:
        await server.aclose()
