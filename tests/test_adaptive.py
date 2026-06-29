"""Tests for adaptive quality control."""

from pdum.rfb import AdaptiveQualityController
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


def test_floor_tightens_inflight():
    c = AdaptiveQualityController(min_bitrate=1_000_000, bitrate=1_000_000, max_inflight=3, inflight=3, cooldown_s=0.0)
    target = c.update({"decode_queue_size": 9}, now=0.0)
    assert target is not None
    assert target.max_inflight == 2  # bitrate already at floor -> tighten latency


async def test_session_applies_adaptation_and_rebuilds_encoder():
    builds: list[int] = []

    def factory(w, h, bitrate):
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
