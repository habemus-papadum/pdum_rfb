# Remote Framebuffer Addendum: Sparse Frame Timing, WebTransport, and Binary WebSocket Framing

This addendum covers the follow-up design points discussed after the first implementation guide:

- Sending frames at a lower or irregular rate than the codec's nominal frame rate.
- Using WebTransport for multiple independent application channels.
- Sending binary data over WebSocket with a JSON/binary envelope.

The target system remains a generic Python-to-JavaScript remote framebuffer, with optional transports for image frames, CPU H.264 via PyAV/libx264, and GPU-accelerated H.264/AV1 via NVIDIA NVENC / PyNvVideoCodec.

---

## 1. Sparse or on-demand frame production with a nominal video codec frame rate

For scientific visualization, the renderer may not produce frames continuously. It may produce frames only when the user pans, rotates, zooms, changes a parameter, or requests a new render.

This is compatible with a video encoder architecture.

A codec configured for `fps=60` does not require the application to call `encode()` exactly 60 times per second. The configured frame rate is primarily used as a timing and rate-control hint. The encoder can usually encode a frame whenever you provide one.

The important rule is:

```text
Encode frames only when the framebuffer actually changes.
Send real presentation timestamps.
Do not fabricate duplicate 60 fps frames unless you specifically want constant-rate video playback.
```

### Correct timestamp handling

If you configure the encoder with a nominal frame rate of 60 fps and assign timestamps like this:

```python
frame.pts = frame_index
frame.time_base = Fraction(1, 60)
```

then frame `N` and frame `N+1` are semantically 1/60 second apart, even if the wall-clock delay was actually 500 ms.

For a live WebSocket + WebCodecs pipeline, you can often draw decoded frames immediately and ignore exact video timing. But for correctness, replay, recording, synchronization, and debugging, it is better to send real monotonic timestamps:

```python
import time

start = time.perf_counter()

def timestamp_us() -> int:
    return int((time.perf_counter() - start) * 1_000_000)
```

Send this timestamp in your WebSocket/WebTransport frame header and use it as the `EncodedVideoChunk.timestamp` on the browser side.

### Quality and bitrate implications

A nominal configuration such as:

```text
fps = 60
bitrate = 12 Mbps
```

combined with an actual delivery rate of 5 fps is usually not a correctness problem, but it does affect rate-control interpretation.

Possible effects:

- The encoder's per-frame budget may not match your intuitive wall-clock bitrate.
- Actual network bitrate may be much lower than the configured bitrate if you encode fewer frames.
- Quality may be higher per displayed frame than in a real 60 fps stream.
- GOP/keyframe intervals based on frame count may behave differently from wall-clock expectations.

For a research framebuffer, this is usually acceptable.

### Recommended operating modes

#### Interactive mode

Use while the user is actively dragging, rotating, zooming, or animating:

```text
nominal_fps: 30 or 60
encode policy: latest frame at up to nominal_fps
timestamps: real monotonic timestamps
GOP: short, e.g. keyframe every 1-2 seconds
B-frames: disabled
```

#### Sparse/on-demand mode

Use when the visualization changes only occasionally:

```text
encode policy: only when scene changes
timestamps: real monotonic timestamps
duplicate frames: no
force keyframe: after resize, reconnect, long idle, or decoder reset
optional: send high-quality still image after interaction settles
```

#### Still-image mode

For very sparse updates, image frames may be simpler and better:

```text
JPEG/WebP: good for lossy interactive stills
PNG: good for exact/lossless final stills
H.264/AV1: better when there is temporal continuity
```

### Frame dropping and backpressure

Prefer dropping frames before encoding:

```text
Good:
  renderer produces frames 1..20
  server keeps latest frame
  encoder only encodes frame 1, then frame 20

Dangerous:
  encoder encodes frames 1..20
  server sends frame 1
  server drops encoded frames 2..19
  server sends encoded frame 20
```

The dangerous case can break decoding because encoded frame 20 may depend on reference frames the browser never received.

If you drop already-encoded delta frames, the next frame sent to the browser should generally be an IDR/keyframe with SPS/PPS included.

---

## 2. WebTransport for multiple independent application channels

WebTransport is useful when one client connection needs to carry several logically independent streams of data.

A remote framebuffer session might need:

- High-rate video chunks.
- Mouse, keyboard, wheel, and resize events.
- Frame acknowledgements and decoder queue-depth messages.
- Error messages.
- Logs or debug metadata.
- Low-frequency application UI state updates.

### WebSocket model

A WebSocket is one reliable ordered message stream:

```text
[video chunk][video chunk][video chunk][small error message]
```

If large video messages are already queued, a small error message can be stuck behind them. You can mitigate this with application-level priority queues and chunking, but the transport itself is still one ordered lane.

### WebTransport model

WebTransport is based on HTTP/3/QUIC and exposes one session containing:

```text
- multiple reliable streams
- unidirectional streams
- bidirectional streams
- unreliable datagrams
```

This maps naturally to a multi-channel remote framebuffer protocol:

```text
WebTransport session
  reliable bidi control stream:
    hello/auth/session setup
    resize
    keyframe request
    fatal errors

  reliable unidirectional video stream:
    encoded H.264/AV1 chunks for WebCodecs

  reliable app/message streams:
    logs
    errors
    low-frequency UI state
    debug metadata

  unreliable datagrams:
    pointer_move
    wheel
    frame_ack
    decoder_queue_depth
    transient telemetry
```

The main win is reduced head-of-line blocking between independent logical streams.

### What WebTransport does not solve automatically

WebTransport does not magically provide application-level priority semantics such as:

```text
control stream priority = 100
video stream priority = 10
logs priority = 1
```

You still design the protocol and scheduling policy. WebTransport gives you better primitives for separation, but your application decides which data goes to streams, which data goes to datagrams, what may be dropped, and what must be delivered reliably.

### Suggested channel policy

Use reliable streams for:

```text
- session setup
- encoded video chunks, initially
- errors
- logs that must not be lost
- UI state changes
- resize and keyframe requests
```

Use datagrams for:

```text
- pointer move events where only the latest state matters
- wheel events if loss is tolerable
- decoder queue-depth telemetry
- frame acknowledgements
- transient performance stats
```

Do not start by sending H.264/AV1 video over unreliable datagrams unless you are prepared to build packetization, loss recovery, and keyframe resynchronization.

### Recommended abstraction

Define an application-level transport interface that can be backed by either WebSocket or WebTransport:

```ts
interface Transport {
  openChannel(name: string, options?: ChannelOptions): Channel;
  sendDatagram?(kind: string, data: Uint8Array): void;
  close(): void;
}

interface Channel {
  send(data: Uint8Array | object): Promise<void>;
  onMessage(cb: (data: Uint8Array | object) => void): void;
  close(): void;
}
```

Then implement:

```text
WebSocketTransport:
  one socket
  application-level channel IDs
  priority queue
  binary framing

WebTransportTransport:
  one WebTransport session
  real streams for channels
  datagrams for latest-wins messages
```

This lets you start with WebSocket and move to WebTransport later without changing the rest of the remote framebuffer architecture.

---

## 3. Binary data over WebSocket

For encoded video frames, binary WebSocket messages are strongly preferable to base64 inside JSON.

Base64 is inefficient because it:

- Adds about 33% size overhead.
- Requires extra encoding on the Python side.
- Requires extra decoding on the JavaScript side.
- Creates larger intermediate strings and more GC pressure.

A WebSocket can carry both text and binary messages. A simple protocol is:

```text
JSON header message
binary payload message
JSON header message
binary payload message
...
```

WebSocket preserves message order, so the browser can pair each header with the following binary payload.

### Minimal video header

```json
{
  "type": "video",
  "channel": "rfb.main",
  "codec": "h264",
  "format": "annexb",
  "timestamp_us": 1234567,
  "frame_id": 42,
  "chunk_type": "key",
  "byte_length": 48123
}
```

Then send the encoded H.264/AV1/JPEG/PNG/WebP bytes as the next binary message.

### Python WebSocket example

```python
import asyncio
import json
import time
import websockets

async def fake_encoded_frames():
    frame_id = 0
    start = time.perf_counter()

    while True:
        # Replace this with PyAV/libx264 or PyNvVideoCodec output.
        encoded_h264 = b"\x00\x00\x00\x01..."  # Annex B H.264 bytes

        timestamp_us = int((time.perf_counter() - start) * 1_000_000)
        is_key = frame_id % 60 == 0

        yield {
            "frame_id": frame_id,
            "timestamp_us": timestamp_us,
            "chunk_type": "key" if is_key else "delta",
            "payload": encoded_h264,
        }

        frame_id += 1
        await asyncio.sleep(1 / 60)

async def handler(ws):
    async for frame in fake_encoded_frames():
        payload = frame["payload"]

        header = {
            "type": "video",
            "channel": "rfb.main",
            "codec": "h264",
            "format": "annexb",
            "timestamp_us": frame["timestamp_us"],
            "frame_id": frame["frame_id"],
            "chunk_type": frame["chunk_type"],
            "byte_length": len(payload),
        }

        await ws.send(json.dumps(header))  # text message
        await ws.send(payload)             # binary message

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765):
        await asyncio.Future()

asyncio.run(main())
```

### JavaScript client example

```js
const ws = new WebSocket("ws://localhost:8765");
ws.binaryType = "arraybuffer";

let pendingHeader = null;

ws.onmessage = async (event) => {
  if (typeof event.data === "string") {
    pendingHeader = JSON.parse(event.data);
    return;
  }

  if (!pendingHeader) {
    console.warn("Received binary payload without header");
    return;
  }

  const header = pendingHeader;
  pendingHeader = null;

  const bytes = new Uint8Array(event.data);

  if (bytes.byteLength !== header.byte_length) {
    console.warn("Payload length mismatch");
  }

  handleVideoChunk(header, bytes);
};
```

### WebCodecs decode example

```js
const decoder = new VideoDecoder({
  output(frame) {
    ctx.drawImage(frame, 0, 0);
    frame.close();
  },
  error(err) {
    console.error("VideoDecoder error:", err);
  },
});

decoder.configure({
  codec: "avc1.42E01F", // example H.264 codec string
  codedWidth: 1280,
  codedHeight: 720,
  // For Annex B H.264, omit `description`.
});

function handleVideoChunk(header, bytes) {
  const chunk = new EncodedVideoChunk({
    type: header.chunk_type, // "key" or "delta"
    timestamp: header.timestamp_us,
    data: bytes,
  });

  decoder.decode(chunk);
}
```

### Multi-channel JSON envelope

The same socket can also carry control, error, event, and stats messages:

```json
{
  "channel": "app.errors",
  "kind": "error",
  "message": "CUDA kernel failed"
}
```

```json
{
  "channel": "rfb.events",
  "kind": "pointer-move",
  "x": 104,
  "y": 88,
  "buttons": 1
}
```

```json
{
  "channel": "rfb.stats",
  "kind": "decoder-queue-depth",
  "frame_id": 42,
  "decode_queue_size": 3
}
```

For higher efficiency, the protocol can later move to a fully binary envelope, but JSON header + binary payload is the best starting point because it is easy to inspect and debug.

---

## 4. Practical transport recommendation

### Start with WebSocket

Use WebSocket first if you want:

- Simple deployment.
- Easy local development.
- Broad browser and server support.
- Compatibility with Python ASGI frameworks.
- A straightforward debug story.

Recommended WebSocket design:

```text
one WebSocket connection
text JSON messages for control/errors/events
binary messages for video/image payloads
server-side priority queue
latest-wins policy for stale frames
keyframe request after drops or decoder reset
```

### Design the API as if WebTransport may come later

Even if WebSocket is the first backend, expose logical channels in your internal API:

```python
await transport.send("rfb.video", encoded_chunk, metadata)
await transport.send("app.errors", {"message": "CUDA failed"})
await transport.send("rfb.stats", {"decode_queue_size": 3})
```

Then `WebSocketTransport` can multiplex these logical channels over one socket, while `WebTransportTransport` can map them to real QUIC streams/datagrams later.

### Move to WebTransport when needed

Use WebTransport when:

- Large video traffic and small control/error traffic interfere with each other.
- You want one session with independent streams.
- You want unreliable latest-wins datagrams for events/stats.
- You are willing to deploy HTTP/3/QUIC infrastructure.

---

## 5. Updated mental model

The remote framebuffer system should not be built around a single transport. It should have a transport-neutral core:

```text
Frame source / renderer
  -> encoder backend
  -> logical channel transport
  -> browser decoder/display
```

Encoder backends:

```text
ImageEncoder:
  NumPy/RGBA -> JPEG/PNG/WebP -> WebSocket binary payload

PyAvH264Encoder:
  NumPy/RGB -> libx264 -> H.264 Annex B -> WebCodecs

NvencEncoder:
  host memory or CUDA/GPU buffer -> PyNvVideoCodec/NVENC -> H.264/AV1 -> WebCodecs
```

Transport backends:

```text
WebSocketTransport:
  easiest first backend
  binary video payloads
  JSON envelope
  app-level multiplexing

WebTransportTransport:
  future high-performance backend
  independent reliable streams
  datagrams for transient messages
```

Browser execution model:

```text
Main thread:
  DOM integration
  input event capture
  canvas/video element ownership if needed

Worker:
  WebSocket or WebTransport connection
  WebCodecs VideoDecoder
  OffscreenCanvas rendering when available
  queue/backpressure monitoring
```

The most useful implementation path is:

```text
1. WebSocket + JSON/binary envelope.
2. JPEG/PNG/WebP image payloads.
3. PyAV/libx264 H.264 Annex B payloads decoded by WebCodecs.
4. Move decoding/rendering to a worker with OffscreenCanvas.
5. Add PyNvVideoCodec/NVENC backend for host-memory and CUDA/GPU-buffer input.
6. Add WebTransport once the WebSocket mux becomes a bottleneck.
```

---

## References

- MDN: WebTransport API — https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API
- MDN: WebCodecs API — https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- W3C: WebCodecs specification — https://www.w3.org/TR/webcodecs/
- W3C: WebCodecs AVC/H.264 codec registration — https://www.w3.org/TR/webcodecs-avc-codec-registration/
- PyAV installation docs — https://pyav.org/docs/develop/overview/installation.html
- PyAV frame API — https://pyav.org/docs/develop/api/frame.html
- PyAV NumPy generation example — https://pyav.org/docs/stable/cookbook/numpy.html
- NVIDIA PyNvVideoCodec documentation — https://docs.nvidia.com/video-technologies/pynvvideocodec/
