"""Per-session performance metrics.

Tracks the quantities the implementation guide lists (section 14): encode time,
payload bytes, in-flight depth, round-trip ACK latency (send -> displayed),
client decode-queue depth, and derived rates (fps, bitrate). The session feeds
these; :meth:`SessionMetrics.snapshot` returns a plain dict for logging, the
``GET /metrics`` side channel, and the adaptive-quality controller.

Latencies use an exponential moving average so the "recent" value reacts quickly
without storing history; counts are cumulative and rates are computed over the
session lifetime.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: EMA smoothing factor for latency gauges (0..1; higher = more reactive).
_EMA_ALPHA = 0.3


def _ema(prev: float, sample: float, *, alpha: float = _EMA_ALPHA) -> float:
    return sample if prev == 0.0 else (1 - alpha) * prev + alpha * sample


@dataclass(slots=True)
class SessionMetrics:
    """Mutable accumulator of one session's performance counters."""

    started_at: float = 0.0
    updated_at: float = 0.0

    frames_sent: int = 0
    frames_dropped: int = 0
    frames_acked: int = 0
    keyframes_sent: int = 0
    bytes_sent: int = 0

    encode_ms: float = 0.0  # EMA of encoder.encode() wall time
    rtt_ms: float = 0.0  # EMA of send -> displayed-ack round trip
    decode_queue_size: int = 0  # last value reported by the client

    # Reflected from the session so a snapshot is self-contained.
    inflight: int = 0
    target_bitrate: int = 0
    target_fps: int = 0

    _extra: dict = field(default_factory=dict)

    def record_encode(self, ms: float, *, now: float) -> None:
        self.encode_ms = _ema(self.encode_ms, ms)
        self.updated_at = now

    def record_sent(self, *, payload_bytes: int, keyframe: bool, now: float) -> None:
        self.frames_sent += 1
        self.bytes_sent += payload_bytes
        if keyframe:
            self.keyframes_sent += 1
        self.updated_at = now

    def record_dropped(self, *, now: float) -> None:
        self.frames_dropped += 1
        self.updated_at = now

    def record_ack(self, *, rtt_ms: float | None, decode_queue_size: int, now: float) -> None:
        self.frames_acked += 1
        if rtt_ms is not None:
            self.rtt_ms = _ema(self.rtt_ms, rtt_ms)
        self.decode_queue_size = decode_queue_size
        self.updated_at = now

    def snapshot(self, *, now: float) -> dict:
        """Return a JSON-serializable view including derived rates."""
        elapsed = max(1e-6, now - self.started_at)
        return {
            "elapsed_s": round(elapsed, 3),
            "frames_sent": self.frames_sent,
            "frames_dropped": self.frames_dropped,
            "frames_acked": self.frames_acked,
            "keyframes_sent": self.keyframes_sent,
            "bytes_sent": self.bytes_sent,
            "fps_sent": round(self.frames_sent / elapsed, 2),
            "fps_acked": round(self.frames_acked / elapsed, 2),
            "bitrate_bps": round(self.bytes_sent * 8 / elapsed),
            "encode_ms": round(self.encode_ms, 2),
            "rtt_ms": round(self.rtt_ms, 2),
            "decode_queue_size": self.decode_queue_size,
            "inflight": self.inflight,
            "target_bitrate": self.target_bitrate,
            "target_fps": self.target_fps,
        }
