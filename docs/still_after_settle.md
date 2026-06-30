# Still after interaction settles

Interactive scientific scenes are **bursty**: while you drag, rotate, or scrub, the
app re-renders fast and a low-latency *lossy* stream (JPEG or H.264) is exactly
right — small payloads, smooth motion, who cares if a gradient is a little blocky
for 200 ms. But the moment you **stop**, that lossy frame is what you sit and stare
at — and now the JPEG ringing or H.264 quantization is all you can see.

"Still after settle" fixes the resting frame. When no new frame has been published
for a short, configurable window (the scene has *settled*), each viewer is sent one
**high-quality still** of the frame it is resting on:

- **image path → a lossless PNG.** Pixel-exact. The blocky JPEG you were looking at
  is silently replaced by the real image.
- **video path → a clean IDR.** True lossless H.264 isn't practical over WebCodecs,
  so the still is a self-contained intra (SPS + PPS + IDR) of the resting frame. It
  refreshes the image and lets a client that dropped deltas during the flurry jump
  straight to the latest. For a *pixel-exact* settled image, use the image path.

It is **opt-in**, costs nothing while you interact, and needs **no client-side
changes** — the browser already treats every image as a keyframe and every IDR as a
decodable access unit.

## Turn it on

One keyword to [`serve`](reference.md#pdum.rfb.server.serve):

```python
import pdum.rfb as rfb

display = await rfb.serve(1280, 720, still_after=0.15)   # 150 ms of quiet → still
while running:
    for ev in display.poll_events():
        state = update(state, ev)
    display.publish(render(state))   # publish lossy frames as fast as you like
    await asyncio.sleep(1 / 30)
```

`still_after` is the idle delay in **seconds**. `0.1`–`0.25` is a good range: long
enough not to fire mid-interaction, short enough to feel instant. `None` (the
default) disables the feature entirely. The demo server exposes it too:

```bash
uv run python -m pdum.rfb.server --pattern bouncing_box --still-after 0.15
```

## How it works

The trigger is **frame-settle, not input-settle** — and that turns out to be the
better signal. In the push model you stop publishing when there is nothing new to
draw, so "no new frame for `still_after` seconds" *is* "the user stopped
interacting", with no input plumbing threaded into the encoder. A scene that keeps
publishing (a live animation) simply never settles, so no stills fire and no work is
wasted.

Each connected viewer decides independently, inside its own
[`RfbSession`](reference.md#pdum.rfb.session.RfbSession):

1. After sending a frame, the session arms a *pending still* and waits for the next
   frame with a timeout of `still_after`.
2. A new frame arriving first cancels the still and re-arms — so during motion the
   still **never** fires.
3. If the wait times out, the session re-sends the **current latest** frame with a
   fresh per-client `seq`, encoded via the encoder's `encode_still()` — a lossless
   PNG (image) or a forced IDR (video). The pending flag is cleared, so exactly one
   still goes out and the loop reverts to a plain blocking wait (no idle busy-loop).
4. The still re-sends the *latest* frame, not the last one actually sent, so it also
   serves as a "catch up to the newest frame, losslessly" after a drop flurry.

Because the still carries a distinct `seq` and is a keyframe, it acks and displays
through the existing backpressure machinery untouched. If a viewer is still catching
up (its in-flight window is full) when the scene settles, its still is **skipped**
rather than queued — it is a one-shot nicety, not a guaranteed delivery.

## Cost

- **While interacting:** zero. The bounded wait only replaces an unbounded one; no
  extra frames are produced until the scene is quiet.
- **On settle:** one extra encode + payload per viewer. A 1280×720 PNG is larger on
  the wire than the JPEG it replaces, but it is sent **once**, when nothing else is
  happening — the opposite of the hot path.

## Adding a still to a custom encoder

The session looks for an optional `encode_still(frame) -> list[EncodedPayload]` on
the encoder (and a `still_frame()` on the source, which the built-in `Display`
provides). Implement it to opt a custom [`EncoderBackend`](reference.md#pdum.rfb.types.EncoderBackend)
into the feature; omit it and stills are silently skipped for that encoder. The
built-ins set the pattern: `ImageEncoder` re-encodes as PNG, the H.264 backends
re-encode as a forced IDR.
