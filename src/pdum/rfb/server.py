"""WebSocket server + CLI for the remote framebuffer.

``serve()`` runs a ``websockets`` server that negotiates a transport per client
and drives an :class:`~pdum.rfb.session.RfbSession`. The same port also answers a
small HTTP side channel used by the headless e2e harness:

* ``GET /health`` -> ``ok`` (readiness probe for Playwright's ``webServer``)
* ``GET /recorded-events`` -> JSON list of every input event received
* ``GET /recorded-events/reset`` -> clears the list (per-test isolation)

``python -m pdum.rfb.server`` streams a deterministic :class:`SyntheticFrameSource`
so a browser (or Playwright) can connect with no extra setup.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from http import HTTPStatus
from pathlib import Path
from typing import Any, Callable

from .adaptive import AdaptiveQualityController
from .encoders.base import build_encoder
from .protocol import config_message, parse_control, select_transport
from .session import RfbSession
from .types import EventDict, FrameSource

#: Builds a fresh :class:`FrameSource` for each client connection.
SourceFactory = Callable[[], FrameSource]


def _h264_importable() -> bool:
    import importlib.util

    return importlib.util.find_spec("av") is not None


class _RecordingSource:
    """Wrap a source so every handled event is mirrored to a sink."""

    def __init__(self, inner: FrameSource, sink: Callable[[EventDict], None]) -> None:
        self._inner = inner
        self._sink = sink

    async def next_frame(self):
        return await self._inner.next_frame()

    async def handle_event(self, event: EventDict) -> None:
        self._sink(event)
        await self._inner.handle_event(event)

    @property
    def current_size(self) -> tuple[int, int]:
        return getattr(self._inner, "current_size", (0, 0))


class RfbServer:
    """Holds shared state (recorded events) across client connections."""

    def __init__(
        self,
        source_factory: SourceFactory,
        *,
        has_h264: bool | None = None,
        fps: int = 30,
        bitrate: int = 12_000_000,
        max_inflight: int = 2,
        adaptive: bool = False,
        event_log: str | Path | None = None,
        record_events: bool = False,
    ) -> None:
        self.source_factory = source_factory
        self.has_h264 = _h264_importable() if has_h264 is None else has_h264
        self.fps = fps
        self.bitrate = bitrate
        self.max_inflight = max_inflight
        self.adaptive = adaptive
        self.event_log = Path(event_log) if event_log else None
        self.record_events = record_events or self.event_log is not None
        self.recorded: list[EventDict] = []
        self.sessions: set[RfbSession] = set()

    def _record(self, event: EventDict) -> None:
        if not self.record_events:
            return
        self.recorded.append(event)
        if self.event_log is not None:
            with self.event_log.open("a") as fh:
                fh.write(json.dumps(event) + "\n")

    async def handler(self, connection: Any) -> None:
        import websockets

        try:
            hello_text = await connection.recv()
            hello = parse_control(hello_text)
            supported = hello.get("supported", [])
            selection = select_transport(supported, has_h264=self.has_h264)

            base_source = self.source_factory()
            source = _RecordingSource(base_source, self._record) if self.record_events else base_source
            width, height = getattr(source, "current_size", (640, 480))

            def factory(w: int, h: int, bitrate: int):
                return build_encoder(selection, width=w, height=h, fps=self.fps, bitrate=bitrate)

            encoder = factory(width, height, self.bitrate)
            transport = "webcodecs" if selection.transport == "h264" else "image"
            await connection.send(
                config_message(transport=transport, width=width, height=height, codec=selection.codec)
            )

            controller = (
                AdaptiveQualityController(
                    max_bitrate=self.bitrate,
                    bitrate=self.bitrate,
                    max_inflight=self.max_inflight,
                    inflight=self.max_inflight,
                )
                if self.adaptive
                else None
            )
            session = RfbSession(
                source,
                encoder,
                connection,
                encoder_factory=factory,
                max_inflight=self.max_inflight,
                bitrate=self.bitrate,
                fps=self.fps,
                adaptive=controller,
            )
            self.sessions.add(session)
            try:
                await session.run()
            finally:
                self.sessions.discard(session)
        except websockets.ConnectionClosed:
            pass

    def process_request(self, connection: Any, request: Any):
        """Answer the HTTP side-channel routes; return None to proceed with WS."""
        raw_path = request.path
        path = raw_path.split("?", 1)[0]
        if path == "/health":
            return connection.respond(HTTPStatus.OK, "ok\n")
        if path == "/recorded-events/reset":
            self.recorded.clear()
            return connection.respond(HTTPStatus.OK, "[]")
        if path == "/recorded-events":
            return connection.respond(HTTPStatus.OK, json.dumps(self.recorded))
        if path == "/metrics":
            snapshots = [s.metrics_snapshot() for s in self.sessions]
            return connection.respond(HTTPStatus.OK, json.dumps(snapshots))
        return None


async def serve(
    source_factory: SourceFactory,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    has_h264: bool | None = None,
    fps: int = 30,
    bitrate: int = 12_000_000,
    max_inflight: int = 2,
    adaptive: bool = False,
    event_log: str | Path | None = None,
    record_events: bool = False,
):
    """Start the RFB WebSocket server (async context manager).

    Yields the underlying ``websockets`` server object. Use ``serve_forever`` or
    ``await server.wait_closed()`` to keep it running.
    """
    import websockets.asyncio.server

    rfb = RfbServer(
        source_factory,
        has_h264=has_h264,
        fps=fps,
        bitrate=bitrate,
        max_inflight=max_inflight,
        adaptive=adaptive,
        event_log=event_log,
        record_events=record_events,
    )
    return websockets.asyncio.server.serve(rfb.handler, host, port, process_request=rfb.process_request, max_size=None)


def _build_cli_source_factory(args: argparse.Namespace) -> SourceFactory:
    from .testing import SyntheticFrameSource

    def factory() -> FrameSource:
        return SyntheticFrameSource(
            pattern=args.pattern,
            width=args.width,
            height=args.height,
            fps=args.fps,
            max_frames=args.max_frames,
            pace=True,
        )

    return factory


async def _amain(args: argparse.Namespace) -> None:
    source_factory = _build_cli_source_factory(args)
    server_cm = await serve(
        source_factory,
        host=args.host,
        port=args.port,
        has_h264=False if args.force_image else None,
        fps=args.fps,
        bitrate=args.bitrate,
        adaptive=args.adaptive,
        event_log=args.event_log,
        record_events=args.record_events,
    )
    async with server_cm as server:
        print(f"RFB server on ws://{args.host}:{args.port}  (pattern={args.pattern})")
        await server.serve_forever()


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
    parser.add_argument("--adaptive", action="store_true", help="enable adaptive bitrate/backpressure")
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
