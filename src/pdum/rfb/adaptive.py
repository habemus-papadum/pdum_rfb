"""Adaptive quality control (guide section 10).

A small, pure controller that watches the client's decode-queue depth and
round-trip latency and decides a new target quality. It is deliberately
transport- and encoder-agnostic: it only emits a :class:`QualityTarget`; the
session decides how to apply it (rebuild the H.264 encoder at the new bitrate,
tighten the in-flight ceiling).

Two knobs, applied in order:

* **bitrate** — the primary lever; reduce when congested, recover when healthy;
* **max in-flight** — the latency lever; once bitrate is at the floor and the
  client is still behind, tighten the in-flight ceiling so latest-frame-wins
  drops more aggressively.

A cooldown prevents thrashing (each bitrate change costs a keyframe).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class QualityTarget:
    """A requested change to the session's encoding quality."""

    bitrate: int
    max_inflight: int


@dataclass
class AdaptiveQualityController:
    """Map observed metrics to a target quality with hysteresis + cooldown."""

    min_bitrate: int = 1_000_000
    max_bitrate: int = 12_000_000
    bitrate: int = 12_000_000

    min_inflight: int = 1
    max_inflight: int = 3
    inflight: int = 3

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

        new_bitrate, new_inflight = self.bitrate, self.inflight
        if congested:
            new_bitrate = max(self.min_bitrate, int(self.bitrate * self.down_factor))
            if new_bitrate == self.bitrate:  # already at the floor; tighten latency
                new_inflight = max(self.min_inflight, self.inflight - 1)
        elif healthy:
            new_bitrate = min(self.max_bitrate, int(self.bitrate * self.up_factor))
            new_inflight = min(self.max_inflight, self.inflight + 1)
        else:
            return None

        if new_bitrate == self.bitrate and new_inflight == self.inflight:
            return None

        self.bitrate, self.inflight = new_bitrate, new_inflight
        self._last_change = now
        return QualityTarget(bitrate=new_bitrate, max_inflight=new_inflight)
