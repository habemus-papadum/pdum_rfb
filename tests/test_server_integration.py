"""One real-socket integration test of the WebSocket server.

Exercises the full handshake (hello -> config -> binary frame), event delivery,
and the HTTP side channel used by the headless e2e harness.
"""

import asyncio
import json
import urllib.request

import websockets.asyncio.client
import websockets.asyncio.server

from pdum.rfb.protocol import unpack_binary_message
from pdum.rfb.server import RfbServer
from pdum.rfb.testing import SyntheticFrameSource


def _source_factory():
    return SyntheticFrameSource(pattern="solid", width=64, height=48, fps=120, pace=True)


async def test_server_handshake_event_and_side_channel():
    rfb = RfbServer(_source_factory, has_h264=False, record_events=True)
    async with websockets.asyncio.server.serve(
        rfb.handler, "127.0.0.1", 0, process_request=rfb.process_request, max_size=None
    ) as server:
        port = next(iter(server.sockets)).getsockname()[1]

        # HTTP side channel: health probe used by Playwright's webServer.
        health = await asyncio.to_thread(lambda: urllib.request.urlopen(f"http://127.0.0.1:{port}/health").read())
        assert health.strip() == b"ok"

        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.send(
                json.dumps({"type": "hello", "supported": ["image/jpeg", "image/png"], "device_pixel_ratio": 1})
            )
            config = json.loads(await ws.recv())
            assert config["type"] == "config"
            assert config["transport"] == "image"
            assert config["width"] == 64 and config["height"] == 48

            msg = await ws.recv()
            assert isinstance(msg, (bytes, bytearray))
            header, payload = unpack_binary_message(msg)
            assert header["type"] == "image_frame"
            assert header["width"] == 64 and header["height"] == 48
            assert len(payload) > 0

            await ws.send(
                json.dumps({"type": "event", "event": {"type": "pointer_move", "x": 5, "y": 6, "buttons": 1}})
            )
            # give the server a moment to process the inbound event
            for _ in range(50):
                if any(e.get("type") == "pointer_move" for e in rfb.recorded):
                    break
                await asyncio.sleep(0.02)

            # The metrics side channel reports the active session.
            metrics = await asyncio.to_thread(
                lambda: json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics").read())
            )
            assert len(metrics) == 1
            assert metrics[0]["frames_sent"] >= 1
            assert metrics[0]["bytes_sent"] > 0

        assert any(e.get("type") == "pointer_move" for e in rfb.recorded)

        recorded = await asyncio.to_thread(
            lambda: json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/recorded-events").read())
        )
        assert any(e.get("type") == "pointer_move" for e in recorded)
