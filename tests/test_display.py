"""Unit tests for the push-model Display and its per-connection feed.

No sockets: these drive the Display and its internal `_ClientFeed` directly to
prove publish/fan-out, per-client seq with shared timestamps, latest-wins,
park-until-publish wakeup, the bounded event queue, and clean shutdown.
"""

import asyncio

import numpy as np
import pytest

from pdum.rfb import Display, InputEvent


def _rgb(value=0, w=64, h=48):
    return np.full((h, w, 3), value, dtype=np.uint8)


async def test_publish_infers_format_dims_and_bumps_version():
    d = Display(64, 48)
    assert d._latest is None and d._version == 0
    d.publish(_rgb(10, 64, 48))
    assert d._version == 1
    f = d._latest
    assert f.pixel_format == "rgb24" and (f.width, f.height) == (64, 48)
    assert f.timestamp_us >= 0
    # rgba inferred + dims update
    d.publish(np.zeros((30, 40, 4), dtype=np.uint8))
    assert d._latest.pixel_format == "rgba8" and (d.width, d.height) == (40, 30)
    assert d._version == 2


async def test_publish_rejects_bad_shapes():
    d = Display(16, 16)
    with pytest.raises(ValueError):
        d.publish(np.zeros((16, 16, 2), dtype=np.uint8))
    with pytest.raises(TypeError):
        d.publish("not an array")


async def test_feed_per_client_seq_with_shared_timestamp():
    d = Display(16, 16)
    a = d._make_feed("a", None)
    b = d._make_feed("b", None)
    d.publish(_rgb(1, 16, 16))
    fa0 = await asyncio.wait_for(a.next_frame(), 1.0)
    fb0 = await asyncio.wait_for(b.next_frame(), 1.0)
    # Each feed starts its own dense sequence...
    assert fa0.seq == 0 and fb0.seq == 0
    # ...but they share the one publish-time timestamp.
    assert fa0.timestamp_us == fb0.timestamp_us
    d.publish(_rgb(2, 16, 16))
    fa1 = await asyncio.wait_for(a.next_frame(), 1.0)
    assert fa1.seq == 1


async def test_one_publish_wakes_multiple_parked_feeds():
    d = Display(16, 16)
    a = d._make_feed("a", None)
    b = d._make_feed("b", None)
    # Both park: nothing published yet.
    ta = asyncio.create_task(a.next_frame())
    tb = asyncio.create_task(b.next_frame())
    await asyncio.sleep(0)
    assert not ta.done() and not tb.done()
    d.publish(_rgb(7, 16, 16))
    fa = await asyncio.wait_for(ta, 1.0)
    fb = await asyncio.wait_for(tb, 1.0)
    assert fa.seq == 0 and fb.seq == 0


async def test_latest_wins_skips_intermediate_frames():
    d = Display(16, 16)
    feed = d._make_feed("a", None)
    d.publish(_rgb(1, 16, 16))
    d.publish(_rgb(2, 16, 16))
    d.publish(_rgb(3, 16, 16))  # three publishes, no consumption
    frame = await asyncio.wait_for(feed.next_frame(), 1.0)
    assert int(frame.data[0, 0, 0]) == 3  # newest only
    assert frame.seq == 0  # one delivery -> seq advanced once
    assert feed._last_seen == d._version


async def test_feed_parks_until_publish():
    d = Display(16, 16)
    feed = d._make_feed("a", None)
    d.publish(_rgb(1, 16, 16))
    await asyncio.wait_for(feed.next_frame(), 1.0)  # consume
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(feed.next_frame(), 0.05)  # nothing new -> parks


async def test_poll_events_drains_and_tags_identity():
    d = Display(16, 16)
    feed = d._make_feed("client-1", {"email": "a@b.c"})
    await feed.handle_event({"type": "pointer_move", "x": 1, "y": 2, "buttons": 0})
    await feed.handle_event({"type": "key_down", "key": "a"})
    evs = d.poll_events()
    assert [e.event["type"] for e in evs] == ["pointer_move", "key_down"]
    assert all(isinstance(e, InputEvent) for e in evs)
    assert evs[0].client_id == "client-1" and evs[0].principal == {"email": "a@b.c"}
    assert d.poll_events() == []  # drained


async def test_resize_is_informational_only():
    d = Display(64, 48)
    feed = d._make_feed("a", None)
    await feed.handle_event({"type": "set_viewport", "width": 128, "height": 96, "pixel_ratio": 2})
    assert feed.viewport == (128, 96, 2.0)
    assert (d.width, d.height) == (64, 48)  # publisher owns resolution, not the client
    assert d.poll_events()[0].event["type"] == "set_viewport"


async def test_event_queue_is_bounded_drops_oldest():
    d = Display(16, 16, event_queue_size=3)
    feed = d._make_feed("a", None)
    for i in range(5):
        await feed.handle_event({"type": "wheel", "dy": i})
    evs = d.poll_events()
    assert [e.event["dy"] for e in evs] == [2, 3, 4]  # oldest two dropped


async def test_record_events_accumulates_separately():
    d = Display(16, 16, record_events=True)
    feed = d._make_feed("a", None)
    await feed.handle_event({"type": "pointer_down", "x": 0, "y": 0})
    assert d.recorded == [{"type": "pointer_down", "x": 0, "y": 0}]


async def test_aclose_stops_feeds():
    d = Display(16, 16)
    feed = d._make_feed("a", None)
    task = asyncio.create_task(feed.next_frame())  # parks (nothing published)
    await asyncio.sleep(0)
    await d.aclose()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(task, 1.0)
    assert d._closed
    with pytest.raises(RuntimeError):
        d.publish(_rgb())


async def test_events_async_iterator():
    d = Display(16, 16)
    feed = d._make_feed("a", None)
    received = []

    async def consume():
        async for ev in d.events():
            received.append(ev.event["type"])
            if len(received) == 2:
                return

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    await feed.handle_event({"type": "pointer_move"})
    await feed.handle_event({"type": "pointer_up"})
    await asyncio.wait_for(task, 1.0)
    assert received == ["pointer_move", "pointer_up"]
