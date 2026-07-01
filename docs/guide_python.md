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

!!! tip "Developing on this repo?"
    Clone it and run `./scripts/setup.sh` — one idempotent command bootstraps the
    whole workspace (Python via `uv sync --frozen`, the browser client, pre-commit
    hooks). On a Linux box with an NVIDIA GPU and a CUDA toolkit it also builds the
    PyAV-free NVENC SDK encoder automatically; the `RFB_GPU` env var
    (`auto` default / `force` / `0`) overrides that. See
    [Repository & Development](development.md).

## Mental model

The API is **push**: you own your loop and publish frames into a shared `Display`;
the library fans each frame out to every connected browser.

```text
your loop ── display.publish(ndarray) ─►  Display (latest frame, +version)
   ▲                                         │   one RfbSession + encoder per viewer,
   └── for ev in display.poll_events()       └─► fed from the latest frame, negotiating
       (input from all viewers)                  image vs H.264 per client
```

`serve()` starts the WebSocket server in the **background** and returns the live
`Display`. You decide the cadence — 30 fps, on demand, or every 60 s. The encoder
and transport are still chosen automatically by capability negotiation.

```python
import asyncio
import numpy as np
import pdum.rfb as rfb

def render(state) -> np.ndarray:
    arr = np.zeros((480, 640, 3), dtype=np.uint8)
    arr[:, state["x"] : state["x"] + 40] = (40, 160, 220)   # a moving band
    return arr

async def main():
    display = await rfb.serve(640, 480, port=8765)
    state = {"x": 0}
    try:
        while True:
            for ev in display.poll_events():            # drain input from all viewers
                if ev.event["type"] == "wheel":
                    ...                                 # ev.client_id, ev.principal too
            state["x"] = (state["x"] + 4) % 640
            display.publish(render(state))              # sync, latest-wins, fans out
            await asyncio.sleep(1 / 30)
    finally:
        await display.aclose()

asyncio.run(main())
```

`publish()` is **synchronous** and non-blocking (it stores the latest frame, bumps
a version, and wakes each viewer's session). Call it on the event-loop thread. A
viewer that falls behind simply skips intermediate frames (latest-frame-wins).

### Frame format

`publish()` accepts a contiguous `uint8` NumPy array (or a ready `RawFrame`):

| array shape       | inferred `pixel_format` | notes                                  |
| ----------------- | ----------------------- | -------------------------------------- |
| `(H, W, 3)` uint8 | `rgb24`                 | the common case; required for H.264    |
| `(H, W, 4)` uint8 | `rgba8`                 | image path only (JPEG drops the alpha) |

For the H.264 path keep dimensions **even** (`yuv420p`) and the `pixel_format`
constant. Publishing a **differently-shaped** array transparently resizes the
display: each viewer's encoder is rebuilt and a keyframe forced. Don't mutate an
array after publishing it — return a fresh array each frame (viewers share it).

### Sparse / on-demand rendering

For scientific visualization the framebuffer often changes only on interaction or
a parameter update. Just don't call `publish()` until something changes — there is
no fixed loop to fight. Between changes every viewer's encoder is idle and no bytes
hit the wire; a delta after a long idle still decodes (the browser keeps its
reference state), and the next publish at a new size forces a fresh keyframe.

```python
display = await rfb.serve(1280, 720)
# ... only when your scene actually changes:
display.publish(render(state))
```

### Handling input

`poll_events()` drains the input from **all** connected viewers as a list of
`InputEvent`s (`client_id`, `principal`, `event`, `received_us`). The `event` dict
follows the [renderview vocabulary](https://github.com/pygfx/renderview) shared by
jupyter_rfb / pygfx / fastplotlib (`pointer_move`, `pointer_down`, `pointer_up`,
`wheel`, `key_down`, `key_up`, `resize`): coordinates are **logical** (canvas) pixels,
`button` is `0=none,1=left,2=right,3=middle`, `buttons` is a tuple of pressed buttons,
and `modifiers` are capitalized (`"Shift"`, `"Control"`, …). A `resize` (sent on the
wire as `set_viewport`) carries logical `width`/`height`, physical `pwidth`/`pheight`,
and `ratio`. In a shared display the publisher owns the resolution, so `resize` is
**informational** (recorded on the event, not applied to the frame size). Prefer the single-loop poll style above; an
`async for ev in display.events()` iterator is also available for a dedicated task.

## Running the server

### `serve()`

```python
display = await serve(
    width, height,             # initial framebuffer size (publish a new shape to resize)
    host="127.0.0.1",
    port=8765,                 # 0 = ephemeral; read it back from display.port
    fps=30,                    # advisory: IDR cadence / metrics target (you set the real rate)
    bitrate=12_000_000,
    max_inflight=2,            # per-client latest-frame-wins ceiling
    has_h264=None,             # None = auto-detect PyAV; False = force image
    has_nvenc=None,            # None = auto-detect NVENC GPU; True = force; False = CPU libx264
    still_after=None,          # seconds of quiet → resend a lossless still (see below)
    authenticate=None,         # async hook (see Authentication below)
    origins=None,              # allowed Origin values (CSWSH defense)
    record_events=False,       # also expose received events at GET /recorded-events
    event_log=None,            # path to append received events as JSONL
    encode_pipeline_depth=0,   # 0 = synchronous (default); >0 = pipelined encode (NVENC)
)
# ... publish in your own loop ...
await display.aclose()         # stops the server, disconnects viewers, frees encoders
```

`serve()` returns a started `Display` (no `serve_forever()` — you own the loop).
The same port answers a small HTTP side channel used by tests and tooling:

- `GET /health` → `ok`
- `GET /metrics` → JSON array, one object per active session
- `GET /recorded-events` → JSON list of received input events
- `GET /recorded-events/reset` → clears the list

### Still after settle

`serve(still_after=0.15)` opts in to **"still after interaction settles"**: stream
lossy JPEG/H.264 while the user interacts, then — once no new frame has been
published for `still_after` seconds — re-send each viewer a high-quality still of the
resting frame (a **lossless PNG** on the image path, a clean **IDR** on the video
path). Opt-in, zero cost while interacting, no client changes. See
[Still after settle](still_after_settle.md) for the full write-up.

### Pipelined encode

`serve(encode_pipeline_depth=k)` is an opt-in throughput knob. The default (`0`) is
synchronous 1-in-1-out — lowest latency, the right choice for interactive use. `> 0`
lets a pipelining hardware encoder keep several frames in flight (token-based seq
attribution keeps stats correct), trading ≈`k/fps` of added latency for throughput. It
helps the **NVENC** backend; on **VideoToolbox** it is measured to be correct but not
faster (low-latency RC is synchronous). See [Pipelined encode](pipelined_encode.md).

### Authentication

`serve(authenticate=...)` takes an async hook `fn(AuthContext) -> principal | None`,
called once per connection right after the client's `hello`, before any frame is
sent. Return any object to accept (it rides on every `InputEvent.principal`), or
`None` to reject (the socket closes with code `4401`). The library ships only the
hook and `AuthContext` — verification is your code, with **no JWT dependency**. In
v1 the credential arrives in `hello` (`AuthContext.token`); the context also carries
`headers`/`path` so a future same-site-cookie / ASGI transport feeds the same hook.

```python
from google.oauth2 import id_token            # your dependency, not the library's
from google.auth.transport import requests as g_requests

ALLOWED = {"alice@example.com"}
_req = g_requests.Request()

async def authenticate(ctx):
    if not ctx.token:
        return None
    try:
        claims = id_token.verify_oauth2_token(ctx.token, _req, audience=CLIENT_ID)
    except ValueError:
        return None
    return claims if claims.get("email") in ALLOWED else None

display = await rfb.serve(1280, 720, authenticate=authenticate)
```

The browser sends the token via the `token` option on `RemoteFramebufferView` (see
the [JavaScript guide](guide_javascript.md)).

### Multiple viewers

Several browsers can connect to one `Display` and watch the same stream; each gets
its own encoder and a keyframe on attach, and `display.client_count` reports how
many are connected.

### Multiple streams (named displays)

To host **several** framebuffers — different cameras/viewports, a dashboard of
plots, per-user views — from **one port**, use a hub. Each stream is an independent
`Display` a browser attaches to by URL path (`ws://host/<name>`):

```python
server = await rfb.serve_server(port=8765)
cam   = server.add_stream("camera", 1280, 720)
depth = server.add_stream("depth", 640, 480, has_h264=False)
# publish into cam / depth independently; GET /streams lists them
await server.aclose()
```

`serve(w, h)` is just the single-`"default"`-stream case and still returns a
`Display`; reach the hub behind it via `display.server` to add more. See
[Multiple streams](multiple_streams.md) for routing, the REST listing, and
per-stream auth.

### Mounting in an ASGI app (Starlette / FastAPI)

`serve()` runs its own `websockets` listener. If you instead want the framebuffer
**inside** an existing Starlette/FastAPI app — same origin, sharing its TLS and
session/OAuth cookie — install `[asgi]` and mount an endpoint over the *same*
Display/session core:

```python
from pdum.rfb.asgi import rfb_endpoint
app.add_websocket_route("/rfb", rfb_endpoint(display, authenticate=cookie_auth))
```

It's purely opt-in — the `serve()` path is unchanged. See the
[ASGI / Starlette adapter](asgi.md) guide for the lifespan/publish-loop shape,
cookie auth, and multi-stream mounting.

### The built-in CLI

```bash
uv run python -m pdum.rfb.server --pattern bouncing_box --port 8765
```

Useful flags: `--pattern {test_card,gradient,bouncing_box,counter,checkerboard,solid}`,
`--width/--height/--fps/--bitrate`, `--force-image`, `--no-nvenc`, `--adaptive`,
`--record-events`, `--event-log events.jsonl`, `--max-frames N`. The demo owns a
publish loop streaming a deterministic pattern, so any browser (or the demo page)
can connect with no extra setup.

### The interactive demo harness

For a hands-on tour of the whole stack, `pdum-rfb demo` (from the `[demo]` extra) brings
up a live feed, serves the browser client via Vite, and opens a Textual TUI to switch demo
scenes and **encode backends live** (image ⇄ libx264 ⇄ VideoToolbox ⇄ NVENC), retune
bitrate/fps, and watch per-session stats — all on one WebSocket, no reconnect. `pdum-rfb
demo --smoke` runs the same machinery headlessly as a self-test. See `docs/demo.md`.

## The rendercanvas backend

If you render with [`wgpu`](https://wgpu-py.readthedocs.io) / `pygfx` / `fastplotlib`,
`pdum.rfb` ships a [`rendercanvas`](https://rendercanvas.readthedocs.io) backend so your
scene streams to the browser over this library's transport — the spiritual equivalent of
`jupyter_rfb`, but with H.264/WebCodecs and per-client backpressure. It is **cross-platform
(macOS + Linux)**: the rendered frame is downloaded to a host array and published, so no
CUDA/NVENC is required.

```bash
uv add 'habemus-papadum-rfb[rendercanvas]'   # the backend; bring your own wgpu + pygfx
```

```python
import asyncio
import pdum.rfb as rfb
from pdum.rfb.rendercanvas import RfbRenderCanvas, loop
import pygfx

async def main():
    display = await rfb.serve(1280, 720, port=8765)         # normal pdum.rfb server
    canvas = RfbRenderCanvas(display=display, size=(1280, 720))
    renderer = pygfx.renderers.WgpuRenderer(canvas)
    scene, camera = build_scene()                            # your pygfx scene
    pygfx.OrbitController(camera, register_events=renderer)  # mouse/keyboard control

    def animate():
        renderer.render(scene, camera)
        canvas.request_draw(animate)

    canvas.request_draw(animate)
    try:
        await loop.run_async()                               # runs on the current asyncio loop
    finally:
        await display.aclose()

asyncio.run(main())
```

How it fits the push model: each rendered frame is `publish()`ed to the `Display`, and
browser input (pointer / wheel / key) is drained from the display and delivered to the
**canvas** event system — so `pygfx` controllers just work. (With this backend you do *not*
call `display.poll_events()` yourself; the backend drains it.) The canvas size is the
render resolution and what gets published; browser resize is informational (the publisher
owns the resolution). Keep the size **even** for the H.264 path. See
[the design doc](proposals/completed/rendercanvas_backend.md) for internals and the (separate, Linux-only)
zero-copy GPU track.

## Encoders

You rarely construct an encoder directly — `serve()` does it via
`build_encoder(selection, ...)` after negotiation. The pieces:

- **`ImageEncoder(mode="jpeg"|"png"|"webp", quality=80)`** — one independent
  image per frame (always a keyframe). Great for snapshots, stills, and mostly
  static plots. Use JPEG/WebP while interacting, PNG for a lossless final still.
- **`H264CpuEncoder(width, height, fps, bitrate, codec_string)`** — CPU H.264
  via libx264, emitting **Annex B** access units for WebCodecs. Configured for low
  latency (`ultrafast`/`zerolatency`, no B-frames, periodic IDR). Forced keyframes
  are real IDRs with in-band SPS/PPS.
- **`NvencCpuEncoder(width, height, fps, bitrate, codec_string)`** — hardware
  H.264 on an NVIDIA GPU via **NVENC**. A drop-in for the libx264 encoder (same
  Annex B output, same forced-IDR/no-B-frame low-latency config) that offloads
  encoding to the GPU, freeing the CPU and lowering encode latency. Requires a
  width ≥ 160 (an NVENC hardware minimum).

Check availability and self-test at runtime:

```python
from pdum.rfb.encoders.h264_cpu import h264_cpu_available, self_test
assert h264_cpu_available()
assert self_test()   # encodes a few frames and decodes them back with PyAV

from pdum.rfb import nvenc_cpu_available
if nvenc_cpu_available():       # OS + PyAV `h264_nvenc` + a real GPU open all checked
    ...                     # serve() will then auto-select the GPU encoder
```

### Hardware NVENC (GPU H.264)

The NVENC path rides on **PyAV's bundled ffmpeg** (the `av` wheel ships an ffmpeg
built with `h264_nvenc`), so it needs no extra Python package beyond `av` — the
real requirement is a host **NVIDIA driver + an NVENC-capable GPU**, which pip
cannot install. (NVIDIA's own `PyNvVideoCodec` is deliberately *not* used: it
publishes no `cp314` wheel and no sdist, so it will not install on this project's
Python 3.14+.)

```bash
uv add 'habemus-papadum-rfb[nvenc]'   # same PyAV wheel as [h264]; documents intent
```

`serve()` **auto-detects** NVENC and prefers it over libx264 when present, falling
back automatically otherwise:

```python
display = await serve(1280, 720)                 # GPU if available, else CPU
display = await serve(1280, 720, has_nvenc=False) # force the CPU libx264 path
```

From the CLI, `--no-nvenc` forces the CPU path and `--force-image` disables H.264
entirely; the startup line prints which encoder was selected. Availability is
verified at runtime by `nvenc_cpu_available()` (caches its result and retries the GPU
probe, since consumer cards cap concurrent NVENC sessions).

### Zero-copy GPU encoding (CUDA → NVENC)

If you render **on the GPU**, you can skip the host round-trip entirely: a
CuPy/DLPack NV12 (or RGB) device buffer is fed straight to `h264_nvenc` with no copy.
Call `rfb.enable_cuda_context_sharing()` before any CuPy use, then `serve(gpu=True)`
and `publish()` a CuPy array:

```python
import cupy as cp, pdum.rfb as rfb
rfb.enable_cuda_context_sharing()            # before any CuPy CUDA op
display = await rfb.serve(1920, 1080, gpu=True)
display.publish(render_on_gpu())             # a CuPy (H, W, 3) uint8 array
```

This is ~2.4–4.3× lower per-frame latency than the host path and frees the CPU.

`serve(gpu=True)` chooses between **two** GPU backends automatically:

- **`nvenc_gpu_pdum`** (preferred) — the PyAV-free NVIDIA Video Codec SDK encoder from the
  sibling package `habemus-papadum-nvenc` (`import pdum.nvenc`). It needs **no PyAV
  at all**, so it works today on Python 3.14 with a single `pip install`
  (`habemus-papadum-rfb[gpu-nvenc-sdk]`). Gated by `nvenc_gpu_pdum_available()`. It's
  the fastest path measured — see [the SDK evaluation](proposals/completed/nvenc_sdk_evaluation.md).
- **`nvenc_gpu_pyav`** (fallback) — the `from_dlpack` → `h264_nvenc` path above. It
  **requires PyAV ≥ 18** (gated by `rfb.cuda_zerocopy_available()`); on PyAV 17.x a
  pure-Python workaround is impossible, so you build PyAV from source.

If neither is usable, `serve(gpu=True)` raises at startup. Full details, the
conversion helpers, and the build recipe are in
[the GPU zero-copy guide](gpu_zerocopy.md).

### MLX / Apple Metal frames (macOS)

If you render on Apple Silicon with **MLX**, `serve(gpu=True)` selects the **VideoToolbox**
encoder and converts **RGB(A)→NV12 on the GPU** with a custom `mx.fast.metal_kernel` — so the
color conversion stays off the CPU (measured **~0.28 ms vs ~6.6 ms** for the numpy path at
1080p, a **23×** win that also frees a core). `publish()` recognizes an MLX array directly:

```python
import mlx.core as mx, pdum.rfb as rfb

display = await rfb.serve(1920, 1080, gpu=True)   # macOS: VideoToolbox + MLX/Metal
while running:
    rgba = render_scene_mlx(state)                # an (H, W, 4) uint8 mx.array (GPU)
    display.publish(rgba)                         # recognized as a memory="metal" frame
    await asyncio.sleep(1 / 60)
```

`publish()` materializes the MLX render on the calling (loop) thread, then the encoder's worker
thread runs the GPU NV12 conversion and hands VideoToolbox a host NV12 view (unified memory →
the remaining copy is negligible, ≤2 % of frame time — true zero-copy input buys nothing on
Apple Silicon, and pipelining doesn't help either; both are measured dead-ends, see
[the VideoToolbox design doc](proposals/completed/mlx_metal_videotoolbox_encoder_design.md)).

Requirements: the `[mac-vt]` extra (`habemus-papadum-vtenc` / `pdum.vtenc`) and MLX (the
`mac-dev` group). Details:

- **Pre-converted NV12.** If you already produce NV12 in MLX, wrap it so `publish()` skips the
  RGB→NV12 step: `display.publish(rfb.metal.metal_frame(nv12_mx_array))`.
- **Image-only viewers still work.** A viewer that negotiates the image transport (no
  WebCodecs) gets each Metal frame downloaded to host automatically (`MetalHostFrameAdapter`),
  exactly like the CUDA path.
- **Off `gpu=True`.** Publishing a plain numpy RGBA array still works everywhere; it just uses
  the CPU RGB→NV12 conversion (fine at ≤720p, a bottleneck at 1080p+). Convert in MLX and pass
  the `mx.array` to get the GPU path.
- `pdum.rfb.metal.mlx_available()` gates the path; `pdum.rfb.metal.rgb_to_nv12` /
  `to_host_nv12` / `metal_frame` are the helpers (the Metal analog of `pdum.rfb.gpu`).

### Registering a custom encoder

The video-encoder registry is the extension seam — the `nvenc_cpu`, `nvenc_gpu_pyav`, and
`nvenc_gpu_pdum` backends all ride it, and your own encoder slots in the same way:

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
back to the best shared image format. `serve()` sets `has_nvenc` from
`nvenc_cpu_available()` and then builds the registered `"nvenc_cpu"` encoder instead of
`"h264_cpu"`; the transport negotiation itself is identical either way.

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

> For the **end-to-end** story — including how to render these in the browser UI —
> see [Metrics & adaptive quality](metrics_adaptive.md). This section is the
> server-side API.

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
# per stream: curl http://127.0.0.1:8765/streams/<name>/metrics
```

To surface these in the **browser** too, opt in to a periodic server→client `stats`
push — `serve(..., stats_interval=1.0)` (or `--stats-interval 1.0`). Each client then
receives the authoritative RTT, fps, bitrate, encode time, and adaptive targets and
folds them into its `Stats` (the `serverRttMs` / `serverBitrateBps` / `targetFps` …
fields), delivered to the view's `onStats` callback. Without it, the client only
knows its own decode side.

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

Enable a controller that reacts to the client's decode-queue depth and ACK latency
with three levers, applied in order, and recovers when the client drains — with a
cooldown so it doesn't thrash (each change costs a keyframe). It is **opt-in**:

1. **bitrate** — the primary lever (reduce when congested, recover when healthy);
2. **fps** — once bitrate is at its floor and still congested, ease the frame rate
   (the encoder is rebuilt at the new rate);
3. **max in-flight** — once bitrate *and* fps are floored, tighten the in-flight
   ceiling so latest-frame-wins drops more aggressively.

```bash
uv run python -m pdum.rfb.server --adaptive --stats-interval 1.0 --pattern checkerboard
```

```python
display = await serve(1280, 720, adaptive=True, stats_interval=1.0)
```

The policy lives in the pure `AdaptiveQualityController` (thresholds, factors, fps
step, and cooldown are constructor args); the session applies its `QualityTarget` by
rebuilding the encoder at the new bitrate/fps (forcing a keyframe) and sending an
informational `set_quality` message to the client. Pair it with `stats_interval` so
the browser can show what the controller is doing (see the metrics note above).

> _Resolution-scale adaptation_ (a fourth lever) is intentionally **not** automatic:
> in the push model the publisher owns the framebuffer resolution, so the clean place
> to drop resolution is your render loop (publish a smaller array — the encoder
> rebuilds and the browser re-`configure()`s itself). It is noted as future work in
> the [roadmap](roadmap.md).

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
