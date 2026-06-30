"""Tests for RfbSession backpressure and keyframe policy.

Driven deterministically with in-memory fakes and the session's single-step
helpers (``_encode_step`` / ``_handle_control``) — no real sockets or threads'
scheduling, so the invariants are exact.
"""

import numpy as np
import pytest

from pdum.rfb.display import Display
from pdum.rfb.protocol import unpack_binary_message
from pdum.rfb.session import RfbSession
from pdum.rfb.testing import FakeEncoder, FakeWebSocket, SyntheticFrameSource


class _FakeClock:
    """A manually-advanced monotonic clock for deterministic metric timing."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


def _make_session(*, max_inflight=2, max_frames=None, encoder=None, factory=None):
    source = SyntheticFrameSource(pattern="solid", width=64, height=48, fps=1000, pace=False, max_frames=max_frames)
    encoder = encoder or FakeEncoder()
    ws = FakeWebSocket()
    session = RfbSession(source, encoder, ws, encoder_factory=factory, max_inflight=max_inflight)
    return session, ws, source


def _sent_headers(ws):
    return [unpack_binary_message(m)[0] for m in ws.sent]


async def test_first_payload_is_keyframe():
    session, ws, _ = _make_session()
    await session._encode_step()
    headers = _sent_headers(ws)
    assert headers[0]["keyframe"] is True
    assert headers[0]["seq"] == 0


async def test_never_exceeds_max_inflight_and_drops_when_behind():
    session, ws, _ = _make_session(max_inflight=2, max_frames=10)
    results = [await session._encode_step() for _ in range(10)]
    assert results[:2] == ["sent", "sent"]
    assert all(r == "dropped" for r in results[2:])
    assert len(ws.sent) == 2
    assert len(session.inflight) == 2
    assert session.dropped == 8


async def test_latest_frame_wins_skips_stale_seqs_after_ack():
    session, ws, _ = _make_session(max_inflight=2)
    for _ in range(4):  # 2 sent (seq 0,1), 2 dropped (seq 2,3)
        await session._encode_step()
    assert max(h["seq"] for h in _sent_headers(ws)) == 1

    await session._handle_control({"type": "ack", "seq": 0})
    await session._handle_control({"type": "ack", "seq": 1})
    assert session.inflight == set()

    assert await session._encode_step() == "sent"
    newest_seq = _sent_headers(ws)[-1]["seq"]
    assert newest_seq == 4  # seq 2 and 3 were dropped, never replayed
    assert newest_seq > 1


async def test_request_keyframe_forces_next_keyframe():
    session, ws, _ = _make_session(max_inflight=100)
    await session._encode_step()  # seq 0 (already key)
    await session._handle_control({"type": "ack", "seq": 0})
    await session._encode_step()  # seq 1 delta
    await session._handle_control({"type": "ack", "seq": 1})
    assert _sent_headers(ws)[1]["keyframe"] is False

    await session._handle_control({"type": "request_keyframe"})
    await session._encode_step()  # seq 2 should be forced key
    assert _sent_headers(ws)[2]["keyframe"] is True


async def test_keyframe_forced_after_drop():
    session, ws, _ = _make_session(max_inflight=1)
    await session._encode_step()  # seq 0 key, inflight={0}
    assert await session._encode_step() == "dropped"  # behind -> force_keyframe
    await session._handle_control({"type": "ack", "seq": 0})
    await session._encode_step()  # seq 2 sent
    assert _sent_headers(ws)[-1]["keyframe"] is True


async def test_event_and_set_viewport_reach_source():
    session, _, source = _make_session()
    await session._handle_control(
        {"type": "event", "event": {"type": "pointer_move", "x": 10, "y": 20, "buttons": [1]}}
    )
    assert source.events[-1]["type"] == "pointer_move"
    assert source.events[-1]["x"] == 10

    await session._handle_control(
        {"type": "set_viewport", "width": 400, "height": 300, "pwidth": 800, "pheight": 600, "ratio": 2}
    )
    assert source.current_size == (800, 600)  # source renders at the physical size
    assert source.events[-1]["type"] == "resize"
    assert source.events[-1]["pwidth"] == 800


async def test_encoder_rebuilt_and_keyframe_forced_on_size_change():
    builds: list[tuple[int, int, int]] = []

    def factory(w, h, bitrate):
        builds.append((w, h, bitrate))
        return FakeEncoder()

    session, _, _ = _make_session(encoder=FakeEncoder(), factory=factory)
    session.bitrate = 5_000_000
    session._ensure_encoder_for(64, 48)  # initial size, no rebuild
    assert builds == []
    session.force_keyframe = False
    session._ensure_encoder_for(128, 96)  # size change -> rebuild + keyframe
    assert builds == [(128, 96, 5_000_000)]
    assert session.force_keyframe is True


def _feed_session(*, still_after=None, max_inflight=100):
    """A session fed by a real ``_ClientFeed`` (which provides ``still_frame``)."""
    display = Display(64, 48)
    feed = display._make_feed("c", None)
    ws = FakeWebSocket()
    session = RfbSession(feed, FakeEncoder(), ws, max_inflight=max_inflight, still_after=still_after)
    return display, session, ws


def _sent_payloads(ws):
    return [unpack_binary_message(m)[1] for m in ws.sent]


async def test_stills_disabled_without_still_after():
    _display, session, _ = _feed_session(still_after=None)
    assert session._stills_enabled is False


async def test_still_after_settle_sends_one_lossless_still():
    display, session, ws = _feed_session(still_after=0.02)
    assert session._stills_enabled is True

    display.publish(np.zeros((48, 64, 3), dtype=np.uint8))
    assert await session._encode_step() == "sent"  # seq 0, the live (lossy) frame

    # No further publish: the scene settles and exactly one still is emitted.
    assert await session._encode_step() == "still"
    headers = _sent_headers(ws)
    assert len(headers) == 2
    assert headers[1]["seq"] == 1  # fresh per-client seq, distinct from the frame
    assert headers[1]["keyframe"] is True
    assert _sent_payloads(ws)[1] == b"still:1"  # FakeEncoder.encode_still marker

    # One-shot: pending is cleared so the loop reverts to a blocking park.
    assert session._still_pending is False


async def test_no_still_while_frames_keep_coming():
    display, session, ws = _feed_session(still_after=5.0)
    display.publish(np.zeros((48, 64, 3), dtype=np.uint8))
    assert await session._encode_step() == "sent"  # seq 0
    display.publish(np.full((48, 64, 3), 9, dtype=np.uint8))  # a new frame is ready
    # The bounded wait returns the frame immediately; no still despite still_after.
    assert await session._encode_step() == "sent"
    assert all(not p.startswith(b"still:") for p in _sent_payloads(ws))


async def test_still_skipped_when_client_behind():
    display, session, ws = _feed_session(still_after=0.02, max_inflight=1)
    display.publish(np.zeros((48, 64, 3), dtype=np.uint8))
    assert await session._encode_step() == "sent"  # seq 0, now inflight is full
    # Settled, but the client hasn't acked: the still is skipped, not queued.
    assert await session._encode_step() == "still"
    assert len(ws.sent) == 1  # only the live frame went out


async def test_metrics_track_encode_send_and_ack_rtt():
    clock = _FakeClock()
    source = SyntheticFrameSource(pattern="solid", width=64, height=48, fps=1000, pace=False)
    session = RfbSession(source, FakeEncoder(), FakeWebSocket(), max_inflight=100, clock=clock)

    await session._encode_step()  # seq 0 sent
    snap = session.metrics_snapshot()
    assert snap["frames_sent"] == 1
    assert snap["bytes_sent"] > 0
    assert snap["keyframes_sent"] == 1  # first frame is a keyframe

    clock.advance(0.05)  # 50 ms until the ack arrives
    await session._handle_control({"type": "ack", "seq": 0, "decode_queue_size": 2})
    snap = session.metrics_snapshot()
    assert snap["frames_acked"] == 1
    assert snap["decode_queue_size"] == 2
    assert snap["rtt_ms"] == pytest.approx(50, abs=1)
    assert snap["inflight"] == 0
