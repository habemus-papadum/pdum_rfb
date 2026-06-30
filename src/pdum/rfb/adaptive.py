"""Adaptive quality control (guide section 10).

A small, pure controller that watches the client's decode-queue depth and
round-trip latency and decides a new target quality. It is deliberately
transport- and encoder-agnostic: it only emits a :class:`QualityTarget`; the
session decides how to apply it (rebuild the H.264 encoder at the new bitrate,
tighten the in-flight ceiling).

Three knobs, applied in order under congestion:

* **bitrate** — the primary lever; reduce when congested, recover when healthy;
* **fps** — once bitrate is at the floor and the client is still behind, lower the
  target frame rate (the encoder is rebuilt at the new rate, lightening both encode
  cost and bandwidth);
* **max in-flight** — the latency lever; once bitrate *and* fps are at their floors,
  tighten the in-flight ceiling so latest-frame-wins drops more aggressively.

Recovery walks back up when healthy. A cooldown prevents thrashing (each bitrate /
fps change costs a keyframe).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class QualityTarget:
    """A requested change to the session's encoding quality."""

    bitrate: int
    max_inflight: int
    fps: int


@dataclass
class AdaptiveQualityController:
    """Map observed metrics to a target quality with hysteresis + cooldown."""

    min_bitrate: int = 1_000_000
    max_bitrate: int = 12_000_000
    bitrate: int = 12_000_000

    min_inflight: int = 1
    max_inflight: int = 3
    inflight: int = 3

    min_fps: int = 10
    max_fps: int = 30
    fps: int = 30
    fps_step: int = 5

    queue_high: int = 3  # decode_queue_size above this is "congested"
    rtt_high_ms: float = 150.0
    rtt_low_ms: float = 60.0

    cooldown_s: float = 1.0
    down_factor: float = 0.6
    up_factor: float = 1.25

    _last_change: float = -1e9

    def update(self, metrics: dict, *, now: float) -> QualityTarget | None:
        """Return a new target when a change is warranted, else ``None``."""
        if now - self._last_change < self.cooldown_s:
            return None

        queue = int(metrics.get("decode_queue_size", 0))
        rtt = float(metrics.get("rtt_ms", 0.0))
        congested = queue > self.queue_high or (rtt > 0 and rtt > self.rtt_high_ms)
        healthy = queue <= 1 and (rtt == 0 or rtt < self.rtt_low_ms)

        new_bitrate, new_inflight, new_fps = self.bitrate, self.inflight, self.fps
        if congested:
            new_bitrate = max(self.min_bitrate, int(self.bitrate * self.down_factor))
            if new_bitrate == self.bitrate:  # bitrate floored; ease the frame rate
                new_fps = max(self.min_fps, self.fps - self.fps_step)
                if new_fps == self.fps:  # fps floored too; tighten latency
                    new_inflight = max(self.min_inflight, self.inflight - 1)
        elif healthy:
            new_bitrate = min(self.max_bitrate, int(self.bitrate * self.up_factor))
            new_inflight = min(self.max_inflight, self.inflight + 1)
            new_fps = min(self.max_fps, self.fps + self.fps_step)
        else:
            return None

        if (new_bitrate, new_inflight, new_fps) == (self.bitrate, self.inflight, self.fps):
            return None

        self.bitrate, self.inflight, self.fps = new_bitrate, new_inflight, new_fps
        self._last_change = now
        return QualityTarget(bitrate=new_bitrate, max_inflight=new_inflight, fps=new_fps)
