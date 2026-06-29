# Python Guide

This guide covers everything you need to stream frames from Python: producing
frames, choosing an encoder, running the server, handling input events, and the
testing helpers.

## Install

```bash
uv add habemus-papadum-rfb            # image path (numpy, pillow, websockets)
uv add 'habemus-papadum-rfb[h264]'    # + CPU H.264 (PyAV / libx264)
```

`import pdum.rfb` works even without the `h264` extra — the PyAV-dependent
symbols load lazily, so an image-only deployment never imports `av`.

## Mental model

A session wires together three independent concerns:

```text
FrameSource      -> produces RawFrame objects (your renderer)
EncoderBackend   -> turns RawFrame into EncodedPayload (image or H.264)
RfbSession + serve() -> WebSocket transport, negotiation, backpressure
```

You normally implement (or pick) a **FrameSource** and call **`serve()`**. The
encoder and transport are chosen automatically by capability negotiation.

## Producing frames

### From a callback

The quickest path: wrap a `render(seq, timestamp_us) -> np.ndarray` callable.

```python
import asyncio
import numpy as np
from pdum.rfb import RenderCallbackSource, serve

def render(seq: int, t_us: int) -> np.ndarray:
    arr = np.zeros((480, 640, 3), dtype=np.uint8)
    x = (seq * 4) % 640
    arr[:, x : x + 40] = (40, 160, 220)   # a moving band
    return arr

async def main():
    server = await serve(
        lambda: RenderCallbackSource(render, width=640, height=480, fps=30)
    )
    async with server as s:
        await s.serve_forever()

asyncio.run(main())
```

`serve()` takes a **factory** (`() -> FrameSource`) so each browser connection
gets its own source instance.

### Frame format

A `RawFrame` carries a NumPy array whose layout matches `pixel_format`:

| `pixel_format` | array shape       | notes                                  |
| -------------- | ----------------- | -------------------------------------- |
| `rgb24`        | `(H, W, 3)` uint8 | the common case; required for H.264    |
| `rgba8`        | `(H, W, 4)` uint8 | image path only (JPEG drops the alpha) |

Width and height are forced **even** (a `yuv420p` requirement for H.264). Arrays
should be contiguous `uint8`; the H.264 encoder calls `np.ascontiguousarray`
defensively, but producing contiguous arrays avoids a copy.

### Sparse / on-demand rendering

For scientific visualization the framebuffer often changes only on interaction or
a parameter update. `OnDemandFrameSource` renders **only when marked dirty** — no
fabricated duplicate frames — while still sending real timestamps:

```python
from pdum.rfb import OnDemandFrameSource

source = OnDemandFrameSource(render, width=1280, height=720, render_on_event=True)
# ... later, when your scene changes:
source.mark_dirty()
```

With `render_on_event=True` (default) any pointer/key/wheel/resize event marks the
source dirty, so interaction re-renders automatically. Between changes,
`next_frame()` parks, the encoder is idle, and no bytes hit the wire. This pairs
naturally with the video path: a delta after a long idle still decodes because the
browser's decoder keeps its reference state, and a resize forces a fresh keyframe.

### A full custom source

Implement the `FrameSource` protocol directly when you need state or to react to
input. Subclassing `BaseFrameSource` gives you sequence numbers, monotonic
timestamps, fps pacing, event recording, and viewport tracking for free — you only
write `render`:

```python
import numpy as np
from pdum.rfb import BaseFrameSource

class Plot(BaseFrameSource):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.zoom = 1.0

    def render(self, seq: int, t_us: int) -> np.ndarray:
        # draw using self.width/self.height/self.zoom ...
        return np.zeros((self.height, self.width, 3), dtype=np.uint8)

    async def handle_event(self, event):
        await super().handle_event(event)      # records the event, tracks resize
        if event["type"] == "wheel":
            self.zoom *= 1.1 if event["dy"] < 0 else 0.9
```

Received events follow a common vocabulary (`pointer_move`, `pointer_down`,
`pointer_up`, `wheel`, `key_down`, `key_up`, `resize`). On a `resize`,
`BaseFrameSource` updates `self.width`/`self.height` for you; the session rebuilds
the encoder and forces a keyframe when the frame size actually changes.

## Running the server

### `serve()`

```python
server = await serve(
    source_factory,            # () -> FrameSource
    host="127.0.0.1",
    port=8765,
    has_h264=None,             # None = auto-detect PyAV; False = force image
    fps=30,
    bitrate=12_000_000,
    max_inflight=2,            # latest-frame-wins ceiling
    event_log=None,            # path to append received events as JSONL
    record_events=False,       # also expose them at GET /recorded-events
)
async with server as s:
    await s.serve_forever()
```

`serve()` returns the underlying `websockets` server context manager. The same
port answers a small HTTP side channel used by tests and tooling:

- `GET /health` → `ok`
- `GET /recorded-events` → JSON list of received input events
- `GET /recorded-events/reset` → clears the list

### The built-in CLI

```bash
uv run python -m pdum.rfb.server --pattern bouncing_box --port 8765
```

Useful flags: `--pattern {test_card,gradient,bouncing_box,counter,checkerboard,solid}`,
`--width/--height/--fps/--bitrate`, `--force-image`, `--record-events`,
`--event-log events.jsonl`, `--max-frames N`. This streams a deterministic
`SyntheticFrameSource`, so any browser (or the demo page) can connect with no
extra setup.

## Encoders

You rarely construct an encoder directly — `serve()` does it via
`build_encoder(selection, ...)` after negotiation. The pieces:

- **`ImageEncoder(mode="jpeg"|"png"|"webp", quality=80)`** — one independent
  image per frame (always a keyframe). Great for snapshots, stills, and mostly
  static plots. Use JPEG/WebP while interacting, PNG for a lossless final still.
- **`PyAvH264Encoder(width, height, fps, bitrate, codec_string)`** — CPU H.264
  via libx264, emitting **Annex B** access units for WebCodecs. Configured for low
  latency (`ultrafast`/`zerolatency`, no B-frames, periodic IDR). Forced keyframes
  are real IDRs with in-band SPS/PPS.

Check availability and self-test at runtime:

```python
from pdum.rfb.encoders.pyav_h264 import libx264_available, self_test
assert libx264_available()
assert self_test()   # encodes a few frames and decodes them back with PyAV
```

### Registering a custom encoder

The video-encoder registry is the extension seam (this is where an NVENC backend
would slot in):

```python
from pdum.rfb import register_video_encoder

def make_my_encoder(*, width, height, fps, bitrate, codec_string):
    return MyEncoder(...)

register_video_encoder("myenc", make_my_encoder)
# then: serve(..., )  and build_encoder(sel, ..., video_encoder="myenc")
```

An `EncoderBackend` implements `encode(frame, *, force_keyframe=False) ->
list[EncodedPayload]`, `flush()`, and `close()`.

## Capability negotiation

The client sends a `hello` listing what it can decode; the server picks the best
backend:

```python
from pdum.rfb import select_transport
select_transport(["webcodecs/h264-annexb", "image/jpeg"], has_h264=True)
# -> BackendSelection(transport="h264", codec="avc1.42E01F")
```

Policy (guide §12): prefer H.264 when the client supports `avc1` **and** a video
encoder is available (NVENC preferred over libx264 when present), otherwise fall
back to the best shared image format. `has_nvenc` is already a parameter so a
future NVENC backend changes no call sites.

## Backpressure & timestamps

The session enforces **latest-frame-wins**: at most `max_inflight` payloads are
unacknowledged; when the client is behind, the session drops frames *before*
encoding and forces the next sent frame to be a keyframe (so the stream stays
decodable). The first frame to every client is a keyframe, and a
`request_keyframe` from the client forces one too.

Timestamps are real and monotonic: `BaseFrameSource` stamps each `RawFrame` from a
monotonic clock, the encoder propagates it, and the browser uses it as the
`EncodedVideoChunk.timestamp`. This keeps replay/recording/sync correct even when
frames are sparse.

## Measuring & adapting the encoder

### Per-session metrics

Every session accumulates the metrics the guide lists (§14): encode time, payload
bytes, in-flight depth, round-trip ACK latency (send → displayed), client
decode-queue depth, and derived rates (fps, bitrate).

```python
snap = session.metrics_snapshot()
# {'fps_sent': 30.1, 'bitrate_bps': 2_100_000, 'encode_ms': 1.3,
#  'rtt_ms': 42.0, 'decode_queue_size': 1, 'frames_dropped': 0, ...}
```

When using `serve(..., record_events=...)` or the CLI, the same port exposes them:

```bash
curl http://127.0.0.1:8765/metrics   # JSON array, one object per active session
```

### Offline benchmark

The quickest way to characterize the software encoders — no network, no browser.
It decodes the output back to measure **real** quality (PSNR):

```bash
uv run python -m pdum.rfb.benchmark --frames 120 --pattern gradient \
    --sizes 640x480,1280x720 --jpeg-quality 50,80 --h264-bitrate 2M,8M
```

```text
config            size   enc ms   p95 ms  KB/frame  Mbps@fps  PSNR dB
---------------------------------------------------------------------
jpeg q80       640x480     0.60     0.63      14.0      3.44    34.45
h264 2M        640x480     1.32     1.40       6.6      1.63    49.31
...
```

Call `benchmark_image(...)` / `benchmark_h264(...)` directly for programmatic use;
both return a `BenchmarkResult`.

### Adaptive quality

Enable a controller that lowers bitrate (and, at the floor, tightens the in-flight
ceiling) when the client's decode queue or ACK latency grows, and recovers when it
drains — with a cooldown so it doesn't thrash (each bitrate change costs a
keyframe). It is **opt-in**:

```bash
uv run python -m pdum.rfb.server --adaptive --pattern checkerboard
```

```python
server = await serve(source_factory, adaptive=True)   # or RfbServer(..., adaptive=True)
```

The policy lives in the pure `AdaptiveQualityController` (thresholds, factors, and
cooldown are constructor args); the session applies its `QualityTarget` by
rebuilding the H.264 encoder at the new bitrate (forcing a keyframe) and sending an
informational `set_quality` message to the client.

## Testing helpers

`pdum.rfb.testing` (excluded from coverage on purpose) provides the headless
toolkit:

- `SyntheticFrameSource(pattern=...)` — deterministic GUI-free patterns;
  `render_test_pattern(seq, w, h)` / `expected_quadrant_color(seq, q)` are the
  contract the JS e2e verifies decoded pixels against.
- `decode_annexb(bytes)` — decode an H.264 Annex B stream back to frames with PyAV
  (proves the encoder output is valid without a browser).
- `parse_nal_units` / `has_sps_pps_idr` / `starts_with_start_code` — assert Annex B
  structure.
- `FakeWebSocket` / `FakeEncoder` — drive the session deterministically in tests.
- `gen_fixtures(dir)` (also `python -m pdum.rfb.testing <dir>`) — regenerate the
  protocol parity fixtures consumed by the JavaScript unit tests.

See the [Internals](internals.md) page for how these compose into the three-layer
test strategy, and the [JavaScript Guide](guide_javascript.md) for the browser
side.
