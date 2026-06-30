"""The WebSocket session loop and its backpressure / keyframe policy.

The policy matters more than the plumbing (guide sections 9 and 10):

* latest-frame-wins backpressure: never keep more than ``max_inflight`` payloads
  unacknowledged; drop stale frames rather than letting latency grow;
* the first payload to a new client is a keyframe, and a keyframe is forced
  again after any drop and on an explicit ``request_keyframe``;
* video encoders are fixed-resolution, so the encoder is rebuilt (and a
  keyframe forced) whenever the incoming frame size changes.

CPU-bound encoding runs in a worker thread via :func:`asyncio.to_thread` so the
receive loop keeps draining ACKs, and the two loops run under a
:class:`asyncio.TaskGroup` for clean structured shutdown.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable

from .adaptive import AdaptiveQualityController
from .metrics import SessionMetrics
from .protocol import header_for, pack_binary_message, parse_control
from .types import EncodedPayload, EncoderBackend, FrameSource

try:  # A client disconnect is a normal lifecycle event, not an error.
    from websockets.exceptions import ConnectionClosed as _ConnectionClosed
except Exception:  # pragma: no cover - websockets is a base dependency
    _ConnectionClosed = ()  # type: ignore[assignment]

#: Rebuilds a fixed-resolution encoder for a new (width, height, bitrate).
EncoderFactory = Callable[[int, int, int], EncoderBackend]


class RfbSession:
    """Drive one client connection: encode + send frames, receive events."""

    def __init__(
        self,
        source: FrameSource,
        encoder: EncoderBackend,
        ws: Any,
        *,
        encoder_factory: EncoderFactory | None = None,
        max_inflight: int = 2,
        bitrate: int = 12_000_000,
        fps: int = 30,
        adaptive: AdaptiveQualityController | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.source = source
        self.encoder = encoder
        self.ws = ws
        self.encoder_factory = encoder_factory
        self.max_inflight = max_inflight
        self.bitrate = bitrate
        self.fps = fps
        self.adaptive = adaptive
        self._clock = clock or time.monotonic

        self.force_keyframe = True
        self.inflight: set[int] = set()
        self.dropped = 0
        self.closed = False
        self._enc_size: tuple[int, int] | None = None
        self._send_times: dict[int, float] = {}
        self.metrics = SessionMetrics(started_at=self._clock(), target_bitrate=bitrate, target_fps=fps)

    def metrics_snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of this session's metrics."""
        self.metrics.inflight = len(self.inflight)
        self.metrics.target_bitrate = self.bitrate
        self.metrics.target_fps = self.fps
        return self.metrics.snapshot(now=self._clock())

    # --- receive side -------------------------------------------------------

    async def _handle_control(self, data: dict) -> None:
        """Process one decoded JSON control message (one step of ``recv_loop``)."""
        kind = data.get("type")
        if kind == "ack":
            seq = data.get("seq")
            now = self._clock()
            sent_at = self._send_times.pop(seq, None)
            rtt_ms = (now - sent_at) * 1000 if sent_at is not None else None
            self.inflight.discard(seq)
            self.metrics.inflight = len(self.inflight)
            self.metrics.record_ack(
                rtt_ms=rtt_ms,
                decode_queue_size=int(data.get("decode_queue_size", 0)),
                now=now,
            )
        elif kind == "request_keyframe":
            self.force_keyframe = True
        elif kind == "event":
            await self.source.handle_event(data["event"])
        elif kind == "set_viewport":
            # Renderview-shaped resize: logical width/height, physical pwidth/pheight,
            # ratio. Older clients sent only width/height (physical) + pixel_ratio.
            await self.source.handle_event(
                {
                    "type": "resize",
                    "width": data["width"],
                    "height": data["height"],
                    "pwidth": data.get("pwidth", data["width"]),
                    "pheight": data.get("pheight", data["height"]),
                    "ratio": data.get("ratio", data.get("pixel_ratio", 1)),
                }
            )

    async def recv_loop(self) -> None:
        try:
            async for msg in self.ws:
                if isinstance(msg, (bytes, bytearray)):
                    continue
                await self._handle_control(parse_control(msg))
        except _ConnectionClosed:
            pass
        finally:
            # When the client disconnects, stop the encode loop too.
            self.closed = True

    # --- send side ----------------------------------------------------------

    async def send_payload(self, payload: EncodedPayload) -> None:
        await self.ws.send(pack_binary_message(header_for(payload), payload.payload))
        now = self._clock()
        self.inflight.add(payload.seq)
        self._send_times[payload.seq] = now
        self.metrics.inflight = len(self.inflight)
        self.metrics.record_sent(payload_bytes=len(payload.payload), keyframe=payload.keyframe, now=now)

    def _ensure_encoder_for(self, width: int, height: int) -> None:
        """Rebuild the (fixed-resolution) encoder if the frame size changed."""
        size = (width, height)
        if self._enc_size is None:
            self._enc_size = size
            return
        if size != self._enc_size and self.encoder_factory is not None:
            self.encoder.close()
            self.encoder = self.encoder_factory(width, height, self.bitrate)
            self.force_keyframe = True
            self._enc_size = size

    async def _encode_step(self) -> str:
        """Run one encode iteration. Returns ``"sent"``, ``"dropped"`` or ``"stopped"``."""
        try:
            frame = await self.source.next_frame()
        except StopAsyncIteration:
            return "stopped"

        # Latest-frame-wins: if the client is behind, drop this frame before
        # spending encode time and force the next sent one to be a keyframe.
        if len(self.inflight) >= self.max_inflight:
            self.dropped += 1
            self.force_keyframe = True
            self.metrics.record_dropped(now=self._clock())
            return "dropped"

        self._ensure_encoder_for(frame.width, frame.height)
        force = self.force_keyframe
        t0 = self._clock()
        payloads = await asyncio.to_thread(self.encoder.encode, frame, force_keyframe=force)
        self.metrics.record_encode((self._clock() - t0) * 1000, now=self._clock())
        self.force_keyframe = False

        for payload in payloads:
            await self.send_payload(payload)
        await self._maybe_adapt()
        return "sent"

    async def _maybe_adapt(self) -> None:
        """Apply an adaptive-quality decision, if the controller requests one."""
        if self.adaptive is None:
            return
        target = self.adaptive.update(self.metrics_snapshot(), now=self._clock())
        if target is None:
            return
        self.max_inflight = target.max_inflight
        if target.bitrate != self.bitrate:
            self.bitrate = target.bitrate
            if self.encoder_factory is not None and self._enc_size is not None:
                w, h = self._enc_size
                self.encoder.close()
                self.encoder = self.encoder_factory(w, h, self.bitrate)
                self.force_keyframe = True
        await self.ws.send(json.dumps({"type": "set_quality", "bitrate": self.bitrate, "fps": self.fps}))

    async def encode_loop(self) -> None:
        try:
            while not self.closed:
                result = await self._encode_step()
                if result == "stopped":
                    break
                if result == "dropped":
                    await asyncio.sleep(0)
        except _ConnectionClosed:
            self.closed = True

    async def run(self) -> None:
        """Run the receive and encode loops until the connection closes."""
        try:
            async with asyncio.TaskGroup() as tg:
                tg.create_task(self.recv_loop())
                tg.create_task(self.encode_loop())
        finally:
            self.closed = True
            self.encoder.close()
