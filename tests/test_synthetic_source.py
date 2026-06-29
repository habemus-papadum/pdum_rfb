"""Tests for the headless synthetic frame source."""

import asyncio

import numpy as np
import pytest

from pdum.rfb import OnDemandFrameSource
from pdum.rfb.testing import SyntheticFrameSource, expected_quadrant_color, render_test_pattern


def _blank(seq, t_us):
    return np.zeros((16, 16, 3), dtype=np.uint8)


async def test_render_is_deterministic_and_even_dims():
    src = SyntheticFrameSource(width=65, height=49, pace=False)  # odd dims -> rounded even
    assert src.current_size == (64, 48)
    a = src.render(3, 0)
    b = src.render(3, 0)
    assert np.array_equal(a, b)
    assert a.shape == (48, 64, 3)


async def test_test_card_matches_expected_quadrant_colors():
    arr = render_test_pattern(5, 64, 48)
    # interior of top-left quadrant
    r, g, b = arr[12, 16]
    assert (int(r), int(g), int(b)) == expected_quadrant_color(5, 0)


async def test_next_frame_advances_seq_and_records_timestamp():
    src = SyntheticFrameSource(width=32, height=32, pace=False)
    f0 = await src.next_frame()
    f1 = await src.next_frame()
    assert f0.seq == 0 and f1.seq == 1
    assert f1.timestamp_us >= f0.timestamp_us
    assert src.frames_produced == 2


async def test_max_frames_stops_iteration():
    src = SyntheticFrameSource(width=16, height=16, pace=False, max_frames=2)
    await src.next_frame()
    await src.next_frame()
    with pytest.raises(StopAsyncIteration):
        await src.next_frame()


async def test_events_recorded_in_order_and_resize_updates_size():
    src = SyntheticFrameSource(width=64, height=48, pace=False)
    await src.handle_event({"type": "pointer_move", "x": 1, "y": 2, "buttons": 0})
    await src.handle_event({"type": "resize", "width": 128, "height": 96, "pixel_ratio": 2})
    kinds = [e["type"] for e in src.snapshot_events()]
    assert kinds == ["pointer_move", "resize"]
    assert all("_received_us" in e for e in src.events)
    assert src.current_size == (128, 96)


async def test_rgba_format_produces_four_channels():
    src = SyntheticFrameSource(width=16, height=16, pace=False, pixel_format="rgba8")
    frame = await src.next_frame()
    assert frame.data.shape == (16, 16, 4)
    assert np.all(frame.data[..., 3] == 255)


async def test_on_demand_emits_initial_frame_then_blocks_until_dirty():
    src = OnDemandFrameSource(_blank, width=16, height=16)
    first = await asyncio.wait_for(src.next_frame(), timeout=1.0)
    assert first.seq == 0

    # No change yet -> next_frame must park.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(src.next_frame(), timeout=0.05)

    src.mark_dirty()
    nxt = await asyncio.wait_for(src.next_frame(), timeout=1.0)
    assert nxt.seq == 1


async def test_on_demand_renders_on_event_by_default():
    src = OnDemandFrameSource(_blank, width=16, height=16)
    await asyncio.wait_for(src.next_frame(), timeout=1.0)  # consume the initial frame
    await src.handle_event({"type": "pointer_move", "x": 1, "y": 2, "buttons": 0})
    frame = await asyncio.wait_for(src.next_frame(), timeout=1.0)
    assert frame.seq == 1
    assert src.events[-1]["type"] == "pointer_move"
