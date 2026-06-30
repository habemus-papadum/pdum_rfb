# Internals

How the pieces fit together, the wire protocol, and the design decisions behind
the session loop, the H.264 path, and the worker. Read the
[Python](guide_python.md) and [JavaScript](guide_javascript.md) guides first for
the public API.

## End-to-end data flow

This is the **per-connection, session-internal** view. The public entry point is
`display.publish(ndarray)`, which stores the latest frame; each connection's
`_ClientFeed` is the `FrameSource` the session pulls from below, and input drained
by `display.poll_events()` is what arrives as `handle_event` here.

```text
 Python                                   Browser (main thread)        Worker
 ------                                   ---------------------        ------
 FrameSource.next_frame() ─ RawFrame
        │
        ▼
 EncoderBackend.encode() ─ EncodedPayload
        │  (image bytes | H.264 Annex B AU)
        ▼
 RfbSession.encode_loop ── pack ──► WebSocket ───────────────────────► onmessage
        ▲                                                                  │
        │  ack / request_keyframe / event / set_viewport                   ▼
 RfbSession.recv_loop ◄──────────── WebSocket ◄── normalized events    unpack header
        │                                            ▲                     │
        ▼                                            │              image_frame│video_chunk
 FrameSource.handle_event                  DOM events (pointer/key/      │     │
                                            wheel/resize) normalized  createImageBitmap | VideoDecoder
                                            on the main thread            │     │
                                                                          ▼     ▼
                                                                   draw → OffscreenCanvas
```

Three concerns stay independent so one API can negotiate the best backend:
**FrameSource → EncoderBackend → transport**.

## Wire protocol

Two kinds of messages share one WebSocket.

**Control (JSON text).** Client → server: `hello`, `ack`, `request_keyframe`,
`set_viewport`, `event`. Server → client: `config` (sent right after `hello`),
plus optional `set_quality` / `stats`.

**Payloads (binary).** Each image or encoded video access unit is **one** binary
message with a self-describing envelope:

```text
uint32le header_byte_length | utf8 JSON header | raw payload bytes
```

```python
# pdum/rfb/protocol.py
def pack_binary_message(header: dict, payload: bytes) -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(h)) + h + bytes(payload)
```

```ts
// widgets/src/protocol.ts
export function unpackBinaryMessage(input: ArrayBuffer | Uint8Array): UnpackedMessage;
```

A single self-describing envelope is deliberately chosen over a two-message
"JSON header, then binary payload" scheme: it is **atomic** (no pairing state, no
"binary arrived before its header" race) and keeps ordering trivial. The Python
packer and the TypeScript unpacker are kept byte-compatible by committed fixtures
(`widgets/tests/fixtures/protocol/*`) generated from `pack_binary_message` and
asserted in Vitest.

Image header: `{type:"image_frame", seq, timestamp_us, width, height, mime}`.
Video header: `{type:"video_chunk", seq, timestamp_us, duration_us, width, height,
codec, bitstream:"annexb", keyframe}`.

## Capability negotiation

```text
worker: probeCapabilities() ─ hello{supported:[...], device_pixel_ratio}
                                   │
server: select_transport(supported, has_h264, has_nvenc) ─ BackendSelection
                                   │
server: build_encoder(selection)  ─ config{transport, codec, width, height}
```

`select_transport` prefers H.264 when the client lists `webcodecs/h264-annexb` and
a video encoder exists (NVENC over libx264 when present), else the best shared
image format. `has_nvenc` already exists in the signature so an NVENC backend
changes no callers.

## The session loop

`RfbSession.run()` runs two coroutines under an `asyncio.TaskGroup`:

- **`recv_loop`** iterates inbound messages, dispatching via `_handle_control`:
  `ack` clears the in-flight set, `request_keyframe` arms a keyframe, `event` and
  `set_viewport` go to `source.handle_event`.
- **`encode_loop`** repeatedly runs `_encode_step`: pull the next frame, and if
  `len(inflight) >= max_inflight` **drop it before encoding** (and force the next
  sent frame to be a keyframe); otherwise rebuild the encoder if the frame size
  changed, encode in a worker thread, and send.

Key decisions:

- **Encode off the event loop.** `encode()` is CPU-bound and synchronous, so it
  runs via `await asyncio.to_thread(...)`; the receive loop keeps draining ACKs and
  the in-flight set keeps moving.
- **Latest-frame-wins, drop *before* encoding.** Dropping already-encoded delta
  frames would strand the browser on references it never received; dropping
  pre-encode and forcing the next keyframe keeps the stream decodable. The first
  frame to every client is a keyframe.
- **Fixed-resolution encoders.** libx264 is configured for one size, so a frame
  whose dimensions changed triggers `encoder_factory(w, h)` and a forced keyframe;
  the browser re-`configure()`s its decoder on the new `coded` size.
- **Clean shutdown.** A client disconnect surfaces as `ConnectionClosed`; both
  loops swallow it and set `closed`, so the `TaskGroup` completes without noise.

Single-step helpers (`_encode_step`, `_handle_control`) exist so unit tests drive
the policy deterministically with a `FakeWebSocket` + `FakeEncoder`, with no socket
or thread scheduling.

## The H.264 path

`H264CpuEncoder` uses a bare `av.CodecContext.create("libx264", "w")`, which emits
**Annex B** with in-band SPS/PPS — exactly WebCodecs' Annex B mode (never route
through an mp4 muxer, which produces AVCC). The gaps in the original sketch are
fixed:

- **Forced IDR:** `forced-idr=1` at creation **and** per-frame
  `vf.pict_type = PictureType.I` on a forced keyframe (a plain `I` frame without
  `forced-idr` can be a non-IDR the browser treats as a delta).
- **Pixel format:** RGB is explicitly `reformat`ed to `yuv420p` (PyAV does not
  auto-convert on encode); dimensions are even.
- **Low latency:** `ultrafast` / `zerolatency`, `bframes=0`, `keyint=min-keyint=fps`
  for a 1-second IDR cadence, `annexb=1` / `repeat-headers=1` to keep parameter
  sets in-band.

On the browser, `VideoDecoder.configure({codec, codedWidth, codedHeight})` omits
`description` (SPS/PPS are in-band). The `KeyframeGate` drops delta chunks until the
first keyframe after every connect/reconnect/reconfigure; a decoder `error` resets
the gate and sends `request_keyframe`.

Because there are **no B-frames**, decoder output order equals input order, so a
FIFO of queued `seq`s attributes each displayed frame for the `displayed:true`
ACK. (Enabling B-frames would break that assumption — it is documented in the
code.)

## The worker

One **unified** worker handles both transports (selected per message by header
type) because there is exactly one WebSocket and one transferred `OffscreenCanvas`
per session, and the server may switch transport mid-session.

```text
entry.ts        bootstrap; owns the WebSocket; routes control vs binary;
                forwards main-thread messages (init/event/resize/capture/dispose)
connection      (in entry) hello after probeCapabilities; keyframe-gate reset on (re)open
renderer.ts     OffscreenCanvas 2D wrapper: draw / resize / readPixels / toBlob
imageDecode.ts  image_frame -> createImageBitmap -> draw -> bitmap.close()
videoDecode.ts  VideoPipeline: VideoDecoder lifecycle, gate, FIFO seq attribution
backpressure.ts BackpressureController + KeyframeGate (pure, unit-tested)
```

Resource lifetime is explicit: every `VideoFrame` and `ImageBitmap` is `close()`d
immediately after drawing, or the decoder stalls within seconds. Payload views are
copied into fresh `Uint8Array`s before handing them to `Blob`/`EncodedVideoChunk`.

`transferControlToOffscreen()` is one-way: after transfer the main thread must
never touch that canvas's bitmap, so all resize/DPR changes are *messaged* to the
worker, which sets `OffscreenCanvas.width/height`.

### Main ↔ worker contract

Main → worker: `init` (transfers the canvas + url + options), `event`, `resize`,
`capture`, `dispose`. Worker → main: `ready`, `state`, `stats`, `capture-result`
(carries the `ImageData`/`Blob` and the `lastDisplayedSeq` it measured), `error`.

### Event normalization (main thread)

`events.ts` maps DOM events to the [renderview vocabulary](https://github.com/pygfx/renderview)
(shared by jupyter_rfb / pygfx / fastplotlib). Coordinates go through
`pointerToCanvas(cssX, cssY, rect)` = logical canvas pixels (`clientX − rect.left`,
top-left origin) — the publisher maps logical → its framebuffer using the `ratio`
carried on resize. `mapButton`/`mapButtons` translate DOM button enums/bitmask to
renderview's `0=none,1=left,2=right,3=middle` (button) and pressed-button tuple
(buttons). `computeBackingSize` derives the backing store and the effective ratio
reported in `set_viewport` (logical `width`/`height` + physical `pwidth`/`pheight` +
`ratio`).

## Module map

> **Push model.** The public API is `serve(width, height) -> Display`; you
> `display.publish(ndarray)` from your own loop and drain input with
> `display.poll_events()`. `serve()` runs the WebSocket server as a background task.
> Each connection gets its own `RfbSession`, fed by an internal per-connection
> `_ClientFeed` (the `FrameSource` the session pulls). The pull `FrameSource`
> classes in `sources.py` are internal-only now. `RfbSession` is unchanged — it sees
> a `Channel` (`transport.py`) and a feed, both satisfying its thin seams.

```text
src/pdum/rfb/
  types.py          RawFrame, EncodedPayload, InputEvent, FrameSource/EncoderBackend protocols (dep-free)
  protocol.py       envelope, header builders, control parsing, select_transport
  session.py        RfbSession: loops, backpressure, keyframe policy
  display.py        Display (publish/poll_events/aclose) + internal _ClientFeed (per connection)
  auth.py           AuthContext / Authenticator / Principal (pluggable, no JWT dep)
  transport.py      Channel protocol + WebSocketTransport (ASGI/WebTransport seam)
  sources.py        BaseFrameSource, RenderCallbackSource, OnDemandFrameSource (internal now)
  gpu.py            zero-copy GPU helpers: rgb_to_nv12, cuda_frame, context sharing, probes
  metrics.py        SessionMetrics (encode_ms, bytes, RTT, fps, bitrate, ...)
  adaptive.py       AdaptiveQualityController (opt-in via serve(adaptive=True))
  benchmark.py      `python -m pdum.rfb.benchmark` — offline image vs H.264 w/ real PSNR
  cli.py            `pdum-rfb` CLI: doctor (probe encode paths) + benchmark
  server.py         serve()->Display, _ConnectionServer (HTTP side channel), `python -m` CLI
  encoders/
    base.py         registry + build_encoder (registers h264_cpu + nvenc_cpu + nvenc_gpu_pyav + nvenc_gpu_pdum)
    image.py        ImageEncoder (Pillow)
    h264_cpu.py    H264CpuEncoder + h264_cpu_available / self_test
    nvenc_cpu.py        NvencCpuEncoder (host-input GPU h264_nvenc) + nvenc_cpu_available
    nvenc_gpu_pyav.py   NvencGpuPyavEncoder (zero-copy CUDA NV12 -> h264_nvenc, PyAV >= 18)
    nvenc_gpu_pdum.py    NvencGpuPdumEncoder (PyAV-free; rides habemus-papadum-nvenc / pdum.nvenc)
  testing.py        SyntheticFrameSource, fakes, NAL/decode helpers, fixture gen

widgets/src/
  index.ts                public exports
  RemoteFramebufferView.ts main-thread controller (canvas, events, resize, capture)
  protocol.ts  events.ts  eventTypes.ts  capabilities.ts  backpressure.ts  types.ts
  workerFactory.ts        inline worker (?worker&inline)
  worker/{entry,renderer,imageDecode,videoDecode}.ts
```

## Testing architecture

Three layers verify the system with no display and no manual clicking:

1. **Python (`pytest`).** Protocol round-trips (+ golden fixtures for the JS side),
   image-encoder validity (re-decoded with Pillow), session invariants
   (`max_inflight`, keyframe-first, latest-frame-wins, forced-keyframe-on-drop,
   event delivery), negotiation, and — for H.264 — the produced Annex B bitstream
   is **decoded back with PyAV** to prove validity. One real loopback-socket test
   covers the handshake + HTTP side channel.
2. **JS unit (Vitest).** The protocol unpacker is asserted **byte-for-byte against
   the Python-generated fixtures**; event-coordinate scaling and the
   backpressure/keyframe-gate logic are tested in isolation.
3. **Browser e2e (Playwright + headless Chromium).** `webServer` boots the Python
   server (streaming the deterministic `test_card` pattern) and a production build
   of the demo. A spec decodes real frames, **reads back canvas pixels** via the
   `capture` hook, and checks they form a valid `render_test_pattern(k)` frame — the
   four palette colors in the correct spatial cycle, via `matchedRotation` (the
   TypeScript mirror of Python's `render_test_pattern`; flat quadrant colors keep
   lossy decode within tolerance). The check is on the frame's *structure*, not a
   specific `seq`: the browser-visible `lastDisplayedSeq` is a per-client wire
   counter, not the server's render counter, so the two need not match. A second
   spec injects real pointer/key/wheel events and asserts the server received the
   normalized versions via `GET /recorded-events`. The image path is unconditional;
   the H.264 path is gated on `VideoDecoder.isConfigSupported` and skipped-with-log
   where the browser lacks `avc1`.

## Extension points

- **Encoders.** `register_video_encoder(name, factory)` + the `has_nvenc` flag in
  `select_transport` are the seam new backends slot into with no changes to the
  session or transport. Three NVENC backends already ride it: `nvenc_cpu` (host-input
  `h264_nvenc`), `nvenc_gpu_pyav` (zero-copy CUDA→NVENC via PyAV ≥ 18), and `nvenc_gpu_pdum`
  (PyAV-free, via the sibling `pdum.nvenc` package).
- **Frames.** Push `ndarray`s, **CuPy/DLPack CUDA tensors**, or `RawFrame`s to
  `Display.publish()` — a CUDA tensor becomes a `memory="cuda"` frame for the GPU
  encoders. The internal per-connection `_ClientFeed` is the `FrameSource` the
  session pulls; `BaseFrameSource` remains for internal/test use.
- **Transport.** The session only needs an object with `await send(...)` and async
  iteration. A future logical-channel `Transport`/`Channel` abstraction (WebSocket
  now, WebTransport later — see the addendum) can wrap this without touching the
  encoder or source layers.
