"""Tests for adaptive quality control."""

import numpy as np

from pdum.rfb import AdaptiveQualityController, Display, DownscaleHint
from pdum.rfb.session import RfbSession
from pdum.rfb.testing import FakeEncoder, FakeWebSocket, SyntheticFrameSource


def _ctrl(**kw):
    return AdaptiveQualityController(
        max_bitrate=10_000_000, bitrate=10_000_000, max_inflight=3, inflight=3, cooldown_s=1.0, **kw
    )


def test_congestion_lowers_bitrate():
    c = _ctrl()
    target = c.update({"decode_queue_size": 5, "rtt_ms": 0}, now=10.0)
    assert target is not None
    assert target.bitrate < 10_000_000


def test_high_rtt_lowers_bitrate():
    c = _ctrl()
    target = c.update({"decode_queue_size": 0, "rtt_ms": 250}, now=10.0)
    assert target is not None
    assert target.bitrate < 10_000_000


def test_health_recovers_bitrate_after_drop():
    c = _ctrl()
    c.update({"decode_queue_size": 5, "rtt_ms": 0}, now=10.0)  # drop
    target = c.update({"decode_queue_size": 0, "rtt_ms": 10}, now=20.0)  # healthy
    assert target is not None
    assert target.bitrate > c.min_bitrate


def test_cooldown_suppresses_rapid_changes():
    c = _ctrl()
    assert c.update({"decode_queue_size": 5}, now=10.0) is not None
    assert c.update({"decode_queue_size": 5}, now=10.5) is None  # within cooldown


def test_floored_bitrate_lowers_fps_first():
    # Bitrate at the floor, fps headroom left: ease the frame rate before latency.
    c = AdaptiveQualityController(
        min_bitrate=1_000_000, bitrate=1_000_000, max_inflight=3, inflight=3, fps=30, min_fps=10, cooldown_s=0.0
    )
    target = c.update({"decode_queue_size": 9}, now=0.0)
    assert target is not None
    assert target.fps < 30
    assert target.max_inflight == 3  # inflight untouched while fps still has room


def test_floor_tightens_inflight():
    # Bitrate AND fps both floored -> tighten latency.
    c = AdaptiveQualityController(
        min_bitrate=1_000_000,
        bitrate=1_000_000,
        max_inflight=3,
        inflight=3,
        min_fps=30,
        fps=30,
        cooldown_s=0.0,
    )
    target = c.update({"decode_queue_size": 9}, now=0.0)
    assert target is not None
    assert target.max_inflight == 2  # bitrate + fps already at floor -> tighten latency


async def test_session_applies_adaptation_and_rebuilds_encoder():
    builds: list[int] = []

    def factory(w, h, bitrate, fps):
        builds.append(bitrate)
        return FakeEncoder()

    source = SyntheticFrameSource(pattern="solid", width=64, height=48, fps=1000, pace=False)
    ctrl = AdaptiveQualityController(
        max_bitrate=10_000_000, bitrate=10_000_000, max_inflight=3, inflight=3, cooldown_s=0.0
    )
    session = RfbSession(
        source,
        FakeEncoder(),
        FakeWebSocket(),
        encoder_factory=factory,
        max_inflight=3,
        bitrate=10_000_000,
        adaptive=ctrl,
    )

    # Simulate a congested client, then drive an encode step that triggers adapt.
    session.metrics.decode_queue_size = 9
    await session._encode_step()
    assert session.bitrate < 10_000_000
    assert builds and builds[-1] == session.bitrate  # encoder rebuilt at the new bitrate
    # a set_quality control message was sent to the client
    assert any("set_quality" in str(m) for m in session.ws.sent)


# --- resolution lever (the fourth, deepest knob) ---------------------------


def _floored_ctrl(*, scale: float = 1.0, **kw):
    """A controller with bitrate / fps / in-flight all already at their floors, so the
    next congested update engages the resolution lever."""
    return AdaptiveQualityController(
        min_bitrate=1_000_000,
        bitrate=1_000_000,
        max_bitrate=1_000_000,
        min_fps=30,
        max_fps=30,
        fps=30,
        min_inflight=1,
        max_inflight=1,
        inflight=1,
        min_scale=0.5,
        scale=scale,
        scale_step=0.5,
        cooldown_s=0.0,
        **kw,
    )


def test_sustained_congestion_drops_resolution():
    t = _floored_ctrl().update({"decode_queue_size": 9}, now=0.0)
    assert t is not None and t.scale == 0.5


def test_resolution_is_the_last_lever():
    # With in-flight headroom, congestion tightens in-flight first and leaves scale at 1.0.
    c = AdaptiveQualityController(
        min_bitrate=1_000_000, bitrate=1_000_000, min_fps=30, max_fps=30, fps=30, inflight=3, cooldown_s=0.0
    )
    t = c.update({"decode_queue_size": 9}, now=0.0)
    assert t is not None and t.max_inflight == 2 and t.scale == 1.0


def test_health_recovers_resolution():
    t = _floored_ctrl(scale=0.5).update({"decode_queue_size": 0, "rtt_ms": 0}, now=0.0)
    assert t is not None and t.scale == 1.0


def test_resolution_floored_at_min_scale():
    # Already at min_scale with every other lever floored → nothing left to give.
    assert _floored_ctrl(scale=0.5).update({"decode_queue_size": 9}, now=0.0) is None


async def test_downscale_hint_flows_through_poll_events_and_recovers():
    display = Display(640, 480)
    feed = display._make_feed("c0", None)
    session = RfbSession(
        feed,
        FakeEncoder(),
        FakeWebSocket(),
        encoder_factory=lambda w, h, b, f: FakeEncoder(),
        max_inflight=1,
        bitrate=1_000_000,
        adaptive=_floored_ctrl(),
    )

    # Congested: the controller shrinks resolution → a DownscaleHint appears in poll_events.
    display.publish(np.zeros((480, 640, 3), np.uint8))
    session.metrics.decode_queue_size = 9
    await session._encode_step()
    hints = [e for e in display.poll_events() if isinstance(e, DownscaleHint)]
    assert hints and hints[-1].scale == 0.5
    assert (hints[-1].width, hints[-1].height) == (320, 240)  # even(base * scale)

    # Recovery: healthy client → scale climbs back to 1.0 and a clearing hint is emitted.
    session.inflight.clear()  # simulate the client acking the in-flight frame
    session._send_times.clear()
    display.publish(np.zeros((480, 640, 3), np.uint8))
    session.metrics.decode_queue_size = 0
    session.metrics.rtt_ms = 0.0
    await session._encode_step()
    hints = [e for e in display.poll_events() if isinstance(e, DownscaleHint)]
    assert hints and hints[-1].scale == 1.0
    assert (hints[-1].width, hints[-1].height) == (640, 480)


async def test_most_congested_viewer_wins_the_shared_downscale():
    # Two viewers on one display: the lower (more congested) scale drives the shared hint;
    # when that viewer leaves, the aggregate relaxes back up.
    display = Display(640, 480)
    a = display._make_feed("a", None)
    b = display._make_feed("b", None)

    a.suggest_render_scale(0.75)
    b.suggest_render_scale(0.5)
    hints = [e for e in display.poll_events() if isinstance(e, DownscaleHint)]
    assert hints[-1].scale == 0.5  # min across viewers

    # The congested viewer disconnects → the remaining viewer's 0.75 becomes the aggregate.
    display._remove("b", b, None)
    hints = [e for e in display.poll_events() if isinstance(e, DownscaleHint)]
    assert hints[-1].scale == 0.75
