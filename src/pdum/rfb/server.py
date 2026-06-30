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


async def _close_feed_on_disconnect(connection: Any, feed: _ClientFeed) -> None:
    """Stop ``feed`` when the socket closes, so a parked encode loop unparks.

    Without this, a client that disconnects while its session is idle (parked in
    ``next_frame`` waiting for the next publish) would never wake, and the
    session's ``TaskGroup`` would not complete.
    """
    try:
        await connection.wait_closed()
    finally:
        feed.close()


class _ConnectionServer:
    """Per-``Display`` connection handler: negotiate, authenticate, run sessions."""

    def __init__(
        self,
        display: Display,
        *,
        has_h264: bool | None = None,
        has_nvenc: bool | None = None,
        fps: int = 30,
        bitrate: int = 12_000_000,
        max_inflight: int = 2,
        adaptive: bool = False,
        still_after: float | None = None,
        authenticate: Authenticator | None = None,
        gpu: bool = False,
    ) -> None:
        self.display = display
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
        self.authenticate = authenticate

    async def handler(self, connection: Any) -> None:
        import websockets

        try:
            hello = parse_control(await connection.recv())

            principal = await self._authenticate(connection, hello)
            if principal is _REJECTED:
                await connection.close(4401, "unauthorized")
                return

            supported = hello.get("supported", [])
            try:
                selection = select_transport(supported, has_h264=self.has_h264, has_nvenc=self.has_nvenc)
            except UnsupportedClient:
                await connection.close(1003, "no supported transport")
                return

            client_id = uuid4().hex
            feed = self.display._make_feed(client_id, principal)
            width, height = self.display.width, self.display.height

            def factory(w: int, h: int, bitrate: int):
                encoder = build_encoder(
                    selection,
                    width=w,
                    height=h,
                    fps=self.fps,
                    bitrate=bitrate,
                    video_encoder=self.video_encoder,
                )
                # In GPU mode the publisher pushes CUDA frames; an image-transport
                # viewer's host encoder is wrapped so those frames are downloaded.
                if self.gpu and selection.transport == "image":
                    from .gpu import HostFrameAdapter

                    encoder = HostFrameAdapter(encoder)
                return encoder

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
                feed,
                encoder,
                WebSocketTransport(connection),
                encoder_factory=factory,
                max_inflight=self.max_inflight,
                bitrate=self.bitrate,
                fps=self.fps,
                adaptive=controller,
                still_after=self.still_after,
            )
            self.display._register_session(session)
            closer = asyncio.create_task(_close_feed_on_disconnect(connection, feed))
            try:
                await session.run()
            finally:
                closer.cancel()
                self.display._remove(client_id, feed, session)
        except websockets.ConnectionClosed:
            pass

    async def _authenticate(self, connection: Any, hello: dict) -> Any:
        """Return the principal, ``None`` (anonymous), or ``_REJECTED``."""
        if self.authenticate is None:
            return None
        req = getattr(connection, "request", None)
        ctx = AuthContext(
            token=hello.get("token"),
            headers=getattr(req, "headers", None),
            path=getattr(req, "path", None),
            remote=getattr(connection, "remote_address", None),
            hello=hello,
        )
        try:
            principal = await self.authenticate(ctx)
        except Exception:
            return _REJECTED
        return _REJECTED if principal is None else principal

    def process_request(self, connection: Any, request: Any):
        """Answer the HTTP side-channel routes; return None to proceed with WS."""
        path = request.path.split("?", 1)[0]
        if path == "/health":
            return connection.respond(HTTPStatus.OK, "ok\n")
        if path == "/recorded-events/reset":
            self.display.recorded.clear()
            return connection.respond(HTTPStatus.OK, "[]")
        if path == "/recorded-events":
            return connection.respond(HTTPStatus.OK, json.dumps(self.display.recorded))
        if path == "/metrics":
            snapshots = [s.metrics_snapshot() for s in self.display._sessions]
            return connection.respond(HTTPStatus.OK, json.dumps(snapshots))
        return None


#: Sentinel distinguishing "authentication failed" from an anonymous ``None``.
_REJECTED = object()


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
    authenticate:
        Optional async hook (see :mod:`pdum.rfb.auth`); rejected connections are
        closed with code ``4401`` before any frame is sent.
    origins:
        Allowed ``Origin`` values (CSWSH defense) passed to ``websockets``.
    """
    import websockets.asyncio.server

    display = Display(
        width,
        height,
        fps=fps,
        record_events=record_events,
        event_log=event_log,
        event_queue_size=event_queue_size,
    )
    conn = _ConnectionServer(
        display,
        has_h264=has_h264,
        has_nvenc=has_nvenc,
        fps=fps,
        bitrate=bitrate,
        max_inflight=max_inflight,
        adaptive=adaptive,
        still_after=still_after,
        authenticate=authenticate,
        gpu=gpu,
    )
    kwargs: dict[str, Any] = dict(process_request=conn.process_request, max_size=None)
    if origins is not None:
        kwargs["origins"] = origins
    cm = websockets.asyncio.server.serve(conn.handler, host, port, **kwargs)
    display._server = await cm.__aenter__()
    display._server_cm = cm
    return display


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
    parser.add_argument("--adaptive", action="store_true", help="enable adaptive bitrate/backpressure")
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
