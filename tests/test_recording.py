"""Tests for the server-side MP4 recording tap (``Display.record``).

Records a short synthetic stream to a real ``.mp4`` and **re-decodes it with PyAV** to
prove it is a valid, correctly-timed file — mirroring the "Annex B decoded back with
PyAV" style of ``test_pyav_h264.py``. Skips cleanly when PyAV is absent.
"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest

from pdum.rfb import Display, RawFrame
from pdum.rfb.recording import recording_available

pytestmark = pytest.mark.skipif(not recording_available(), reason="PyAV (the [h264] extra) not available")

W, H = 64, 48


class _Clock:
    """A hand-advanced monotonic clock so frame timestamps are deterministic."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _frame(seq: int) -> np.ndarray:
    # A flat, per-seq color: robust to lossy H.264 and cheap to encode.
    return np.full((H, W, 3), ((seq * 30) % 256, (seq * 17) % 256, 64), dtype=np.uint8)


async def _publish_and_capture(display: Display, rec, frame) -> None:
    """Publish one frame and wait until the recorder has encoded it.

    Defeats latest-frame-wins in the test so every published frame lands in the file,
    giving a deterministic frame count and timing to assert on.
    """
    before = rec.frames_written
    display.publish(frame)
    for _ in range(2000):
        if rec.frames_written > before:
            return
        await asyncio.sleep(0.001)
    raise AssertionError("recorder did not capture the published frame in time")


def _decode(path) -> list:
    import av

    frames = []
    with av.open(str(path)) as container:
        for frame in container.decode(video=0):
            frames.append(frame)
    return frames


async def test_records_a_valid_mp4_that_redecodes(tmp_path):
    clock = _Clock()
    display = Display(W, H, clock=clock)
    path = tmp_path / "out.mp4"

    async with display.record(path) as rec:
        for seq in range(8):
            clock.t = seq * 0.05  # 20 fps, constant cadence
            await _publish_and_capture(display, rec, _frame(seq))

    assert rec.frames_written == 8
    assert path.exists() and path.stat().st_size > 0

    frames = _decode(path)
    assert len(frames) == 8  # every published frame decodes back
    assert all(f.width == W and f.height == H for f in frames)


async def test_records_variable_cadence_timing(tmp_path):
    # Sparse / bursty cadence (like still_after scenes): the file's frame *times* must
    # track the real monotonic timestamps, not a fixed tick.
    clock = _Clock()
    display = Display(W, H, clock=clock)
    path = tmp_path / "vfr.mp4"
    times = [0.0, 0.1, 0.15, 0.6, 1.4]  # irregular gaps

    async with display.record(path) as rec:
        for seq, t in enumerate(times):
            clock.t = t
            await _publish_and_capture(display, rec, _frame(seq))

    frames = _decode(path)
    assert len(frames) == len(times)
    decoded = sorted(float(f.time) for f in frames)
    for got, want in zip(decoded, times):
        assert abs(got - want) < 0.01, (decoded, times)


async def test_records_rgba_frames(tmp_path):
    clock = _Clock()
    display = Display(W, H, clock=clock)
    path = tmp_path / "rgba.mp4"

    async with display.record(path) as rec:
        for seq in range(4):
            clock.t = seq * 0.05
            rgba = np.empty((H, W, 4), dtype=np.uint8)
            rgba[..., :3] = _frame(seq)
            rgba[..., 3] = 255
            await _publish_and_capture(display, rec, rgba)

    frames = _decode(path)
    assert len(frames) == 4
    assert all(f.width == W and f.height == H for f in frames)


async def test_record_is_independent_of_viewers(tmp_path):
    # The tap must not register as a viewer (client_count / adaptive aggregation).
    display = Display(W, H)
    path = tmp_path / "headless.mp4"
    async with display.record(path) as rec:
        assert display.client_count == 0  # a recording is not a browser client
        for seq in range(3):
            await _publish_and_capture(display, rec, _frame(seq))
    assert _decode(path)


async def test_record_survives_a_resize(tmp_path):
    # A mid-stream resize scales to the initial size rather than corrupting the file.
    clock = _Clock()
    display = Display(W, H, clock=clock)
    path = tmp_path / "resize.mp4"
    async with display.record(path) as rec:
        clock.t = 0.0
        await _publish_and_capture(display, rec, _frame(0))
        clock.t = 0.05
        await _publish_and_capture(display, rec, np.full((H * 2, W * 2, 3), 90, dtype=np.uint8))

    frames = _decode(path)
    assert len(frames) == 2
    assert all(f.width == W and f.height == H for f in frames)  # scaled to the first size


def test_record_raises_without_pyav(monkeypatch):
    # Simulate PyAV being unavailable: record() must fail fast with a clear message.
    import pdum.rfb.recording as recording

    monkeypatch.setattr(recording, "recording_available", lambda: False)
    display = Display(W, H)
    with pytest.raises(RuntimeError, match="PyAV"):
        display.record("nope.mp4")


def test_rejects_unsupported_pixel_format():
    from pdum.rfb.recording import _snapshot_host

    bad = RawFrame(0, W, H, 0, "nv12", "cpu", np.zeros((H * 3 // 2, W), dtype=np.uint8))
    with pytest.raises(TypeError):
        _snapshot_host(bad)
