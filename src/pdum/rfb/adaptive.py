"""Adaptive quality control (guide section 10).

A small, pure controller that watches the client's decode-queue depth and
round-trip latency and decides a new target quality. It is deliberately
transport- and encoder-agnostic: it only emits a :class:`QualityTarget`; the
session decides how to apply it (rebuild the H.264 encoder at the new bitrate,
tighten the in-flight ceiling).

Four knobs, applied in order under congestion:

* **bitrate** — the primary lever; reduce when congested, recover when healthy;
* **fps** — once bitrate is at the floor and the client is still behind, lower the
  target frame rate (the encoder is rebuilt at the new rate, lightening both encode
  cost and bandwidth);
* **max in-flight** — the latency lever; once bitrate *and* fps are at their floors,
  tighten the in-flight ceiling so latest-frame-wins drops more aggressively;
* **resolution scale** — the deepest lever, engaged only under *sustained* pressure
  (bitrate, fps, and in-flight already floored). Unlike the others the session cannot
  apply it — the publisher owns the framebuffer size — so it surfaces the target
  :attr:`QualityTarget.scale` and the :class:`~pdum.rfb.display.Display` fans a
  :class:`~pdum.rfb.types.DownscaleHint` out through ``poll_events()`` for the render
  loop to honor (publish a smaller frame; the encoder rebuild + keyframe on resize is
  the well-trodden path). See :class:`~pdum.rfb.types.DownscaleHint`.

Recovery walks back up when healthy. A cooldown prevents thrashing (each bitrate /
fps / resolution change costs a keyframe).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class QualityTarget:
    """A requested change to the session's encoding quality.

    ``scale`` is the recommended render-resolution scale in ``(0, 1]`` (``1.0`` = full
    resolution). It is advisory to the *publisher* (surfaced as a
    :class:`~pdum.rfb.types.DownscaleHint`), not applied by the session like the other
    fields; defaults to ``1.0`` so existing callers are unaffected.
    """

    bitrate: int
    max_inflight: int
    fps: int
    scale: float = 1.0


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

    # Resolution scale (deepest lever): 1.0 = full res, floored at min_scale. Absolute,
    # so the render loop applies it to its native size without compounding.
    min_scale: float = 0.5
    scale: float = 1.0
    scale_step: float = 0.25

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
        new_scale = self.scale
        if congested:
            new_bitrate = max(self.min_bitrate, int(self.bitrate * self.down_factor))
            if new_bitrate == self.bitrate:  # bitrate floored; ease the frame rate
                new_fps = max(self.min_fps, self.fps - self.fps_step)
                if new_fps == self.fps:  # fps floored too; tighten latency
                    new_inflight = max(self.min_inflight, self.inflight - 1)
                    if new_inflight == self.inflight:  # everything floored; shrink resolution
                        new_scale = round(max(self.min_scale, self.scale - self.scale_step), 4)
        elif healthy:
            new_bitrate = min(self.max_bitrate, int(self.bitrate * self.up_factor))
            new_inflight = min(self.max_inflight, self.inflight + 1)
            new_fps = min(self.max_fps, self.fps + self.fps_step)
            new_scale = round(min(1.0, self.scale + self.scale_step), 4)
        else:
            return None

        if (new_bitrate, new_inflight, new_fps, new_scale) == (self.bitrate, self.inflight, self.fps, self.scale):
            return None

        self.bitrate, self.inflight, self.fps, self.scale = new_bitrate, new_inflight, new_fps, new_scale
        self._last_change = now
        return QualityTarget(bitrate=new_bitrate, max_inflight=new_inflight, fps=new_fps, scale=new_scale)
