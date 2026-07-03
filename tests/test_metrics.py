"""Unit tests for SessionMetrics — focused on the windowed throughput rates.

`fps_sent` / `bitrate_bps` must track the *current* cadence (a short rolling window),
not a lifetime cumulative average that would crawl toward a new rate over minutes.
"""

from __future__ import annotations

from pdum.rfb.metrics import _RATE_WINDOW_S, SessionMetrics


def _send(m: SessionMetrics, *, bytes_: int, now: float) -> None:
    m.record_sent(payload_bytes=bytes_, keyframe=False, now=now)


def test_windowed_fps_reacts_to_a_cadence_change() -> None:
    m = SessionMetrics(started_at=0.0)

    # 30 fps for 3 s of session time.
    t = 0.0
    while t < 3.0:
        t += 1 / 30
        _send(m, bytes_=1000, now=t)
    assert abs(m.snapshot(now=t)["fps_sent"] - 30) <= 1  # ~30 in the last second

    # Drop to 10 fps; within one window-length the reported rate should reflect it,
    # NOT stay near 30 (which a lifetime average would do for many more seconds).
    for _ in range(int(10 * _RATE_WINDOW_S) + 2):
        t += 1 / 10
        _send(m, bytes_=1000, now=t)
    assert abs(m.snapshot(now=t)["fps_sent"] - 10) <= 1


def test_rate_decays_to_zero_when_frames_stop() -> None:
    m = SessionMetrics(started_at=0.0)
    for i in range(30):
        _send(m, bytes_=2000, now=i / 30)
    # Long after the last frame, the window is empty → rate is 0 (not a stale average).
    snap = m.snapshot(now=1.0 + 5 * _RATE_WINDOW_S)
    assert snap["fps_sent"] == 0
    assert snap["bitrate_bps"] == 0


def test_windowed_bitrate_uses_recent_bytes() -> None:
    m = SessionMetrics(started_at=0.0)
    # 30 frames in the last second, 1000 bytes each → 30_000 bytes/s * 8 = 240_000 bps.
    t = 0.0
    while t < 1.5:
        t += 1 / 30
        _send(m, bytes_=1000, now=t)
    bps = m.snapshot(now=t)["bitrate_bps"]
    assert abs(bps - 240_000) < 30_000
