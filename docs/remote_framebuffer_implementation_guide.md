# Remote Framebuffer Streaming Implementation Guide

This guide describes a transport-neutral remote framebuffer (RFB) design for Python renderers and generic JavaScript frontends. The goal is to let Python produce frames from NumPy, CUDA, OpenGL, or host-memory buffers, stream them to a browser component, and receive mouse/keyboard/resize events back.

The guide covers three concrete implementations:

1. **Image frames over WebSocket**: JPEG/PNG/WebP payloads decoded by browser image APIs.
2. **CPU H.264 over WebSocket + WebCodecs**: PyAV/libx264 encodes video chunks; browser WebCodecs decodes them.
3. **NVIDIA hardware H.264/AV1 over WebSocket + WebCodecs**: PyNvVideoCodec/NVENC encodes from host or GPU memory.

It also explains how much of the JavaScript side can run inside a Web Worker.

---

## 1. Design principles

### Keep the API transport-neutral

Do not bake Jupyter, marimo, NiceGUI, WebRTC, WebSocket, or WebCodecs into the renderer API. Treat the system as a session with three independent concerns:

```text
Frame source      -> produces raw frames
Encoder backend   -> turns raw frames into encoded payloads
Transport backend -> sends encoded payloads + receives events
```

### Prefer a common event vocabulary

All transports should send the same user-input events to Python:

```json
{"type":"resize","width":1280,"height":720,"pixel_ratio":2}
{"type":"pointer_move","x":300,"y":180,"buttons":1,"modifiers":[]}
{"type":"pointer_down","x":300,"y":180,"button":0,"buttons":1}
{"type":"pointer_up","x":300,"y":180,"button":0,"buttons":0}
{"type":"wheel","x":300,"y":180,"dx":0,"dy":-120,"mode":"pixel"}
{"type":"key_down","key":"a","code":"KeyA","modifiers":["shift"]}
{"type":"key_up","key":"a","code":"KeyA","modifiers":[]}
```

### Use latest-frame-wins backpressure

For interactive rendering, old frames are usually worthless. If the browser or network is behind, drop stale frames and send the newest frame or force a new keyframe.

```text
Good policy:
  - keep at most N encoded payloads queued per client
  - drop non-key video frames when behind
  - request/force an IDR keyframe after a drop
  - dynamically lower bitrate, resolution, or framerate if needed

Bad policy:
  - queue every rendered frame forever
  - let latency grow unbounded
```

---

## 2. Recommended project layout

```text
remote_rfb/
  py/
    remote_rfb/
      __init__.py
      types.py
      session.py
      protocol.py
      encoders/
        image.py
        pyav_h264.py
        nvenc_pynv.py
      transports/
        websocket.py
  js/
    src/
      RemoteFramebufferView.ts
      protocol.ts
      image_worker.ts
      webcodecs_worker.ts
      main_thread_view.ts
```

---

## 3. Python-side abstract interfaces

### `types.py`

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

MemoryKind = Literal["cpu", "cuda", "opengl"]
PixelFormat = Literal["rgb24", "rgba8", "bgra8", "nv12", "yuv420p"]
EncodedKind = Literal["image", "video"]


@dataclass(slots=True)
class RawFrame:
    seq: int
    width: int
    height: int
    timestamp_us: int
    pixel_format: PixelFormat
    memory: MemoryKind
    data: Any
    # data examples:
    #   cpu/rgb24: numpy.ndarray[uint8] shape (H, W, 3)
    #   cpu/rgba8: numpy.ndarray[uint8] shape (H, W, 4)
    #   cpu/nv12:  numpy.ndarray[uint8] shape (H * 3 // 2, W)
    #   cuda/nv12: object exposing CUDA Array Interface or .cuda() plane pointers
    #   opengl: texture id / framebuffer id plus context metadata


@dataclass(slots=True)
class EncodedPayload:
    seq: int
    kind: EncodedKind
    timestamp_us: int
    payload: bytes
    width: int
    height: int
    mime: str | None = None       # e.g. "image/jpeg", "image/png"
    codec: str | None = None      # e.g. "avc1.42E01F", "av01..."
    keyframe: bool = False
    metadata: dict[str, Any] | None = None


class FrameSource(Protocol):
    async def next_frame(self) -> RawFrame:
        ...

    async def handle_event(self, event: dict[str, Any]) -> None:
        ...


class EncoderBackend(Protocol):
    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        ...

    def flush(self) -> list[EncodedPayload]:
        ...

    def close(self) -> None:
        ...
```

---

## 4. Wire protocol

Use JSON messages for control and a simple binary envelope for image/video payloads.

### Control messages

Client to server:

```json
{"type":"hello","supported":["image/jpeg","image/png","webcodecs/h264-annexb"],"device_pixel_ratio":2}
{"type":"ack","seq":42,"decode_queue_size":0,"displayed":true}
{"type":"request_keyframe","reason":"dropped_frames"}
{"type":"set_viewport","width":1280,"height":720,"pixel_ratio":2}
{"type":"event","event":{"type":"pointer_move","x":100,"y":50,"buttons":1}}
```

Server to client:

```json
{"type":"config","transport":"webcodecs","codec":"avc1.42E01F","width":1280,"height":720}
{"type":"set_quality","bitrate":12000000,"fps":60}
{"type":"stats","server_queue":0,"dropped":3}
```

### Binary payload envelope

Send each image frame or encoded video access unit as one WebSocket binary message:

```text
uint32le header_byte_length
utf8 JSON header
raw payload bytes
```

Example header for JPEG/PNG:

```json
{
  "type":"image_frame",
  "seq":42,
  "timestamp_us":700000,
  "width":1280,
  "height":720,
  "mime":"image/jpeg"
}
```

Example header for H.264 Annex B:

```json
{
  "type":"video_chunk",
  "seq":42,
  "timestamp_us":700000,
  "duration_us":16666,
  "width":1280,
  "height":720,
  "codec":"avc1.42E01F",
  "bitstream":"annexb",
  "keyframe":false
}
```

A helper implementation:

```python
import json
import struct


def pack_binary_message(header: dict, payload: bytes) -> bytes:
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(header_bytes)) + header_bytes + payload
```

```ts
export function unpackBinaryMessage(buf: ArrayBuffer): { header: any; payload: Uint8Array } {
  const view = new DataView(buf);
  const n = view.getUint32(0, true);
  const headerBytes = new Uint8Array(buf, 4, n);
  const header = JSON.parse(new TextDecoder().decode(headerBytes));
  const payload = new Uint8Array(buf, 4 + n);
  return { header, payload };
}
```

---

## 5. Transport 1: JPEG/PNG/WebP over WebSocket

This is the simplest backend and is ideal for:

- snapshots
- debug views
- low-to-medium frame rates
- mostly static plots
- notebook/marimo/NiceGUI-style widget integration

It is not ideal for fullscreen 60 fps high-entropy animation, because every frame is an independent image.

### Python encoder

Install:

```bash
pip install pillow numpy websockets
```

Skeleton:

```python
from __future__ import annotations

from io import BytesIO
from typing import Literal

import numpy as np
from PIL import Image

from .types import RawFrame, EncodedPayload


class ImageEncoder:
    def __init__(
        self,
        *,
        mode: Literal["jpeg", "png", "webp"] = "jpeg",
        quality: int = 80,
    ):
        self.mode = mode
        self.quality = quality

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        if frame.memory != "cpu":
            raise TypeError("ImageEncoder expects CPU frames")

        arr = frame.data
        if not isinstance(arr, np.ndarray):
            raise TypeError("Expected numpy.ndarray")

        if frame.pixel_format == "rgb24":
            img = Image.fromarray(arr, "RGB")
        elif frame.pixel_format == "rgba8":
            img = Image.fromarray(arr, "RGBA")
        else:
            raise ValueError(f"Unsupported pixel format for image encoder: {frame.pixel_format}")

        out = BytesIO()
        if self.mode == "jpeg":
            # JPEG cannot store alpha.
            if img.mode == "RGBA":
                img = img.convert("RGB")
            img.save(out, format="JPEG", quality=self.quality, optimize=False)
            mime = "image/jpeg"
        elif self.mode == "png":
            img.save(out, format="PNG")
            mime = "image/png"
        elif self.mode == "webp":
            img.save(out, format="WEBP", quality=self.quality)
            mime = "image/webp"
        else:
            raise ValueError(self.mode)

        return [
            EncodedPayload(
                seq=frame.seq,
                kind="image",
                timestamp_us=frame.timestamp_us,
                width=frame.width,
                height=frame.height,
                mime=mime,
                payload=out.getvalue(),
                keyframe=True,
            )
        ]

    def flush(self) -> list[EncodedPayload]:
        return []

    def close(self) -> None:
        pass
```

### JavaScript display path

For the image path, a worker can receive frames, decode using `createImageBitmap`, and paint to an `OffscreenCanvas`.

```ts
// image_worker.ts
import { unpackBinaryMessage } from "./protocol";

let ws: WebSocket;
let canvas: OffscreenCanvas;
let ctx: OffscreenCanvasRenderingContext2D;

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;

  if (msg.type === "init") {
    canvas = msg.canvas;
    ctx = canvas.getContext("2d")!;

    ws = new WebSocket(msg.url);
    ws.binaryType = "arraybuffer";

    ws.onmessage = async (event) => {
      if (typeof event.data === "string") {
        // handle JSON control messages
        return;
      }

      const { header, payload } = unpackBinaryMessage(event.data);
      if (header.type !== "image_frame") return;

      const blob = new Blob([payload], { type: header.mime });
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();

      ws.send(JSON.stringify({ type: "ack", seq: header.seq, displayed: true }));
    };
  }
};
```

Main thread:

```ts
// main_thread_view.ts
const canvas = document.querySelector("canvas")!;
const offscreen = canvas.transferControlToOffscreen();
const worker = new Worker(new URL("./image_worker.ts", import.meta.url), { type: "module" });

worker.postMessage(
  {
    type: "init",
    url: "wss://example.com/rfb/session/abc",
    canvas: offscreen,
  },
  [offscreen]
);

function sendPointerEvent(ev: PointerEvent) {
  worker.postMessage({
    type: "event",
    event: {
      type: ev.type,
      x: ev.offsetX,
      y: ev.offsetY,
      button: ev.button,
      buttons: ev.buttons,
    },
  });
}

canvas.addEventListener("pointermove", sendPointerEvent);
canvas.addEventListener("pointerdown", sendPointerEvent);
canvas.addEventListener("pointerup", sendPointerEvent);
```

Notes:

- The worker can own the WebSocket and rendering context.
- DOM event capture still happens on the main thread; forward normalized events to the worker or directly to the server.
- Use JPEG while interacting, PNG for final/still/lossless frames, and WebP if browser support and encoding speed are acceptable.

---

## 6. Transport 2: PyAV/libx264 CPU H.264 over WebSocket + WebCodecs

This is the best CPU fallback path. It gives temporal compression, which matters for continuous video.

### Install

```bash
pip install av numpy websockets
```

PyAV provides binary wheels for Linux, macOS, and Windows linked against FFmpeg; the documented simple install is `pip install av`. If you force a source build, then you need FFmpeg development libraries and `pkg-config`.

### Encoding requirements for WebCodecs

For the browser side, use H.264/AVC in **Annex B** form when possible. For WebCodecs H.264:

- Each `EncodedVideoChunk` should be one access unit, not arbitrary fragments.
- Key chunks should include SPS/PPS and an IDR picture.
- Use no B-frames for low latency.
- Start with baseline or constrained baseline H.264 for broad compatibility.

### PyAV encoder skeleton

This example uses PyAV with x264. Exact options can vary by FFmpeg build, so include a startup self-test that encodes a few frames and verifies the browser can decode them.

```python
from __future__ import annotations

from fractions import Fraction
from typing import Iterable

import av
import numpy as np

from .types import RawFrame, EncodedPayload


class PyAvH264Encoder:
    def __init__(
        self,
        width: int,
        height: int,
        fps: int = 60,
        bitrate: int = 12_000_000,
        codec_string: str = "avc1.42E01F",
    ):
        self.width = width
        self.height = height
        self.fps = fps
        self.bitrate = bitrate
        self.codec_string = codec_string
        self.frame_index = 0

        # Direct codec context. Alternative: use av.open(..., format="h264")
        # and mux packets through the raw h264 muxer.
        self.ctx = av.CodecContext.create("libx264", "w")
        self.ctx.width = width
        self.ctx.height = height
        self.ctx.time_base = Fraction(1, fps)
        self.ctx.framerate = Fraction(fps, 1)
        self.ctx.pix_fmt = "yuv420p"
        self.ctx.bit_rate = bitrate

        # Low latency: ultrafast, no B-frames, periodic IDR.
        self.ctx.options = {
            "preset": "ultrafast",
            "tune": "zerolatency",
            "profile": "baseline",
            # x264 private options. annexb=1 asks for Annex B byte stream.
            "x264-params": f"keyint={fps}:min-keyint={fps}:scenecut=0:bframes=0:annexb=1",
        }
        self.ctx.open()

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        if frame.memory != "cpu" or frame.pixel_format != "rgb24":
            raise TypeError("PyAvH264Encoder example expects CPU rgb24 frames")

        arr = frame.data
        if not isinstance(arr, np.ndarray):
            raise TypeError("Expected numpy.ndarray")

        vf = av.VideoFrame.from_ndarray(arr, format="rgb24")
        vf.pts = self.frame_index
        vf.time_base = Fraction(1, self.fps)
        self.frame_index += 1

        if force_keyframe:
            # PyAV/FFmpeg support for forcing keyframes varies by route.
            # Recreating the encoder or using encoder-specific options may be
            # needed. For a first version, use periodic keyframes via keyint.
            pass

        out: list[EncodedPayload] = []
        for packet in self.ctx.encode(vf):
            payload = bytes(packet)
            if not payload:
                continue

            out.append(
                EncodedPayload(
                    seq=frame.seq,
                    kind="video",
                    timestamp_us=frame.timestamp_us,
                    width=frame.width,
                    height=frame.height,
                    payload=payload,
                    codec=self.codec_string,
                    keyframe=bool(packet.is_keyframe),
                    metadata={"bitstream": "annexb", "encoder": "pyav-libx264"},
                )
            )
        return out

    def flush(self) -> list[EncodedPayload]:
        out = []
        for packet in self.ctx.encode(None):
            out.append(
                EncodedPayload(
                    seq=-1,
                    kind="video",
                    timestamp_us=0,
                    width=self.width,
                    height=self.height,
                    payload=bytes(packet),
                    codec=self.codec_string,
                    keyframe=bool(packet.is_keyframe),
                    metadata={"bitstream": "annexb", "encoder": "pyav-libx264"},
                )
            )
        return out

    def close(self) -> None:
        self.flush()
```

### Practical PyAV notes

- `VideoFrame.from_ndarray(array, format="rgb24")` is the normal NumPy-to-PyAV path.
- `stream.encode(frame)` / `CodecContext.encode(frame)` returns packets; each packet should be treated as an encoded access unit for WebCodecs only after you verify your encoder/muxing configuration.
- If the browser decoder does not start, check:
  - the codec string (`avc1....`) matches the SPS profile/level
  - key chunks include SPS/PPS and IDR
  - payload is Annex B, not AVCC
  - each chunk is a complete access unit
  - the first chunk sent to a new client is a keyframe

---

## 7. JavaScript WebCodecs worker

WebCodecs is available in dedicated Web Workers, and `OffscreenCanvas` allows canvas rendering in a worker. That makes a worker a good default for the video path.

### Worker responsibilities

The worker can own:

- WebSocket connection
- H.264 chunk parsing
- `VideoDecoder`
- frame drawing to `OffscreenCanvas`
- decode queue monitoring
- ACK/backpressure messages

The main thread should own:

- DOM event capture
- CSS layout
- canvas resize observation
- forwarding pointer/key/wheel/resize events

### Worker skeleton

```ts
// webcodecs_worker.ts
import { unpackBinaryMessage } from "./protocol";

let ws: WebSocket;
let decoder: VideoDecoder;
let canvas: OffscreenCanvas;
let ctx: OffscreenCanvasRenderingContext2D;
let configured = false;
let width = 0;
let height = 0;

function configureDecoder(header: any) {
  if (configured && header.width === width && header.height === height) return;

  width = header.width;
  height = header.height;

  if (decoder) decoder.close();

  decoder = new VideoDecoder({
    output(frame) {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      const seq = (frame as any).__seq;
      frame.close();
      // In practice, seq is not preserved on VideoFrame by WebCodecs.
      // ACK the input chunk after decode() enqueue or maintain your own queue.
    },
    error(error) {
      console.error("VideoDecoder error", error);
      ws?.send(JSON.stringify({ type: "request_keyframe", reason: String(error) }));
    },
  });

  decoder.configure({
    codec: header.codec, // e.g. "avc1.42E01F"
    codedWidth: header.width,
    codedHeight: header.height,
    // If using Annex B H.264, omit `description`.
  });

  configured = true;
}

function handleVideoChunk(header: any, payload: Uint8Array) {
  configureDecoder(header);

  const chunk = new EncodedVideoChunk({
    type: header.keyframe ? "key" : "delta",
    timestamp: header.timestamp_us,
    duration: header.duration_us,
    data: payload,
  });

  decoder.decode(chunk);

  // Simple backpressure signal. The server can lower FPS/bitrate or drop frames.
  ws.send(JSON.stringify({
    type: "ack",
    seq: header.seq,
    decode_queue_size: decoder.decodeQueueSize,
  }));

  if (decoder.decodeQueueSize > 3) {
    ws.send(JSON.stringify({
      type: "slow_down",
      decode_queue_size: decoder.decodeQueueSize,
    }));
  }
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;

  if (msg.type === "init") {
    canvas = msg.canvas;
    ctx = canvas.getContext("2d")!;

    ws = new WebSocket(msg.url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "hello",
        supported: ["webcodecs/h264-annexb", "image/jpeg", "image/png"],
        device_pixel_ratio: msg.devicePixelRatio ?? 1,
      }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const control = JSON.parse(event.data);
        // handle config/stats/etc.
        return;
      }

      const { header, payload } = unpackBinaryMessage(event.data);
      if (header.type === "video_chunk") {
        handleVideoChunk(header, payload);
      }
    };
  }

  if (msg.type === "event") {
    ws?.send(JSON.stringify({ type: "event", event: msg.event }));
  }

  if (msg.type === "resize") {
    canvas.width = msg.width;
    canvas.height = msg.height;
    ws?.send(JSON.stringify({
      type: "set_viewport",
      width: msg.width,
      height: msg.height,
      pixel_ratio: msg.pixelRatio,
    }));
  }
};
```

### Worker caveats

- Workers cannot directly access DOM nodes, so pointer/key events still originate on the main thread.
- `VideoFrame` is transferable, but drawing inside the worker avoids bouncing decoded frames to the main thread.
- Use `ResizeObserver` on the main thread, then send resize messages to the worker.
- Browser codec support varies. Add a startup test using `VideoDecoder.isConfigSupported(...)`.

---

## 8. Transport 3: NVIDIA/PyNvVideoCodec hardware path

This is the likely high-performance path for continuous CUDA/OpenGL-generated video.

### What PyNvVideoCodec gives you

PyNvVideoCodec is NVIDIA's Python binding for hardware video encode/decode using NVIDIA GPUs. The encoder accepts raw frames from either CPU host memory or GPU device memory and produces encoded bitstreams suitable for files or streaming. It supports CPU and GPU buffer modes; CPU buffer mode means host-memory input copied into CUDA/NVENC, not CPU software encoding.

Important PyNvVideoCodec concepts:

```text
CreateEncoder(...) -> stateful NVENC encoder
Encode(frame)      -> bytes of compressed bitstream
Encode(frame, pic_flags)
EndEncode()        -> flush delayed output
Reconfigure(...)   -> adjust bitrate/framerate/rate control at runtime
```

Useful picture flags:

```text
FORCEIDR       -> force IDR keyframe
OUTPUT_SPSPPS  -> include SPS/PPS/VPS headers
FORCEINTRA     -> force intra frame
EOS            -> end of stream
```

Supported input formats include NV12, YUV420, ARGB, and ABGR, subject to GPU capabilities. For low latency, prefer no B-frames / IPP GOP and periodic IDR frames.

### Install

```bash
pip install pynvvideocodec
```

You also need an NVIDIA GPU and compatible NVIDIA driver / CUDA / Video Codec SDK runtime support.

### Host-memory input path

This is the easiest NVIDIA path. It still uses NVENC, but your raw frame starts in host memory.

```python
from __future__ import annotations

import numpy as np
import PyNvVideoCodec as nvc

from .types import RawFrame, EncodedPayload


class NvencHostH264Encoder:
    def __init__(self, width: int, height: int, fps: int = 60, bitrate: str = "12M"):
        self.width = width
        self.height = height
        self.fps = fps
        self.codec_string = "avc1.42E01F"

        self.encoder = nvc.CreateEncoder(
            width=width,
            height=height,
            format="NV12",
            use_cpu_buffer=True,
            gpu_id=0,
            codec="h264",
            preset="p1",
            bitrate=bitrate,
            fps=str(fps),
            rc="cbr",
        )

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        if frame.memory != "cpu" or frame.pixel_format != "nv12":
            raise TypeError("NvencHostH264Encoder expects CPU NV12 frames")

        flags = 0
        if force_keyframe:
            # Names may be exposed as enums/constants depending on installed version.
            flags = nvc.NV_ENC_PIC_FLAGS.FORCEIDR | nvc.NV_ENC_PIC_FLAGS.OUTPUT_SPSPPS

        payload = self.encoder.Encode(frame.data, flags) if flags else self.encoder.Encode(frame.data)
        if not payload:
            return []

        return [
            EncodedPayload(
                seq=frame.seq,
                kind="video",
                timestamp_us=frame.timestamp_us,
                width=frame.width,
                height=frame.height,
                payload=payload,
                codec=self.codec_string,
                keyframe=force_keyframe,
                metadata={"bitstream": "annexb", "encoder": "pynvvideocodec-nvenc-host"},
            )
        ]

    def flush(self) -> list[EncodedPayload]:
        payload = self.encoder.EndEncode()
        if not payload:
            return []
        return [
            EncodedPayload(
                seq=-1,
                kind="video",
                timestamp_us=0,
                width=self.width,
                height=self.height,
                payload=payload,
                codec=self.codec_string,
                keyframe=False,
                metadata={"bitstream": "annexb", "encoder": "pynvvideocodec-nvenc-host"},
            )
        ]

    def close(self) -> None:
        self.flush()
```

You need a CPU-side conversion to NV12. For debug, this can be done with PyAV, OpenCV, NumPy, or FFmpeg; for performance, do it on GPU.

### GPU-memory input path

This is the real target for CUDA-generated frames.

```python
class NvencGpuH264Encoder:
    def __init__(self, width: int, height: int, fps: int = 60, bitrate: str = "12M"):
        self.width = width
        self.height = height
        self.fps = fps
        self.codec_string = "avc1.42E01F"

        self.encoder = nvc.CreateEncoder(
            width=width,
            height=height,
            format="NV12",
            use_cpu_buffer=False,
            gpu_id=0,
            codec="h264",
            preset="p1",
            bitrate=bitrate,
            fps=str(fps),
            rc="cbr",
        )

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        if frame.memory != "cuda" or frame.pixel_format != "nv12":
            raise TypeError("NvencGpuH264Encoder expects CUDA NV12 frames")

        flags = 0
        if force_keyframe:
            flags = nvc.NV_ENC_PIC_FLAGS.FORCEIDR | nvc.NV_ENC_PIC_FLAGS.OUTPUT_SPSPPS

        # frame.data must be a GPU buffer object accepted by PyNvVideoCodec,
        # e.g. CUDA Array Interface / DLPack-style object or a wrapper with .cuda().
        payload = self.encoder.Encode(frame.data, flags) if flags else self.encoder.Encode(frame.data)
        if not payload:
            return []

        return [
            EncodedPayload(
                seq=frame.seq,
                kind="video",
                timestamp_us=frame.timestamp_us,
                width=frame.width,
                height=frame.height,
                payload=payload,
                codec=self.codec_string,
                keyframe=force_keyframe,
                metadata={"bitstream": "annexb", "encoder": "pynvvideocodec-nvenc-gpu"},
            )
        ]
```

### CUDA/OpenGL source frames

For CUDA-rendered frames:

```text
CUDA RGBA/BGRA frame
  -> CUDA kernel convert RGBA/BGRA to NV12
  -> PyNvVideoCodec GPU buffer input
  -> H.264 Annex B payload
  -> WebSocket
  -> WebCodecs VideoDecoder
```

For OpenGL-rendered frames:

```text
OpenGL framebuffer/texture
  -> CUDA/OpenGL interop or GStreamer GL/CUDA bridge
  -> CUDA NV12 buffer
  -> NVENC
```

The OpenGL route is more integration-heavy because you need to preserve the current GL context and safely interop with CUDA/NVENC. Expect a small native adapter, GStreamer pipeline, or CUDA-GL interop layer if you want to avoid GPU-to-CPU readback.

### When to use GStreamer instead

If the PyNvVideoCodec path becomes painful for OpenGL textures, GStreamer may be the better hardware-media pipeline:

```text
appsrc or GL/CUDA source
  -> cudaconvert / cudaconvertscale
  -> nvh264enc / nvav1enc
  -> appsink or WebRTC/WebTransport/WebSocket bridge
```

GStreamer has NVIDIA nvcodec elements such as `nvh264enc`, `nvav1enc`, `cudaconvert`, `cudaconvertscale`, and CUDA memory support. This path is more operationally complex but may reduce copies and solve media-pipeline details that are awkward in pure Python.

---

## 9. WebSocket session loop

This is intentionally rough; the important part is the policy.

```python
import asyncio
import json
import time

from .protocol import pack_binary_message
from .types import FrameSource, EncoderBackend, EncodedPayload


class RfbSession:
    def __init__(self, source: FrameSource, encoder: EncoderBackend, ws):
        self.source = source
        self.encoder = encoder
        self.ws = ws
        self.force_keyframe = True
        self.max_inflight = 2
        self.inflight: set[int] = set()
        self.closed = False

    async def recv_loop(self):
        async for msg in self.ws:
            if isinstance(msg, bytes):
                continue
            data = json.loads(msg)

            if data.get("type") == "ack":
                self.inflight.discard(data["seq"])
                if data.get("decode_queue_size", 0) > 3:
                    # Lower bitrate/fps or drop more aggressively.
                    pass

            elif data.get("type") == "request_keyframe":
                self.force_keyframe = True

            elif data.get("type") == "event":
                await self.source.handle_event(data["event"])

            elif data.get("type") == "set_viewport":
                await self.source.handle_event({
                    "type": "resize",
                    "width": data["width"],
                    "height": data["height"],
                    "pixel_ratio": data.get("pixel_ratio", 1),
                })

    async def send_payload(self, payload: EncodedPayload):
        if payload.kind == "image":
            header = {
                "type": "image_frame",
                "seq": payload.seq,
                "timestamp_us": payload.timestamp_us,
                "width": payload.width,
                "height": payload.height,
                "mime": payload.mime,
            }
        else:
            header = {
                "type": "video_chunk",
                "seq": payload.seq,
                "timestamp_us": payload.timestamp_us,
                "width": payload.width,
                "height": payload.height,
                "codec": payload.codec,
                "bitstream": payload.metadata.get("bitstream", "annexb") if payload.metadata else "annexb",
                "keyframe": payload.keyframe,
            }

        await self.ws.send(pack_binary_message(header, payload.payload))
        self.inflight.add(payload.seq)

    async def encode_loop(self):
        while not self.closed:
            frame = await self.source.next_frame()

            # Latest-frame-wins policy.
            if len(self.inflight) >= self.max_inflight:
                # Drop this frame before spending encode time, or encode only if keyframe needed.
                await asyncio.sleep(0)
                continue

            payloads = self.encoder.encode(frame, force_keyframe=self.force_keyframe)
            self.force_keyframe = False

            for payload in payloads:
                await self.send_payload(payload)

    async def run(self):
        await asyncio.gather(self.recv_loop(), self.encode_loop())
```

---

## 10. Backpressure and latency policy

### Image path

- Only encode if the client has acknowledged the previous frame, or allow one frame in flight.
- During pointer interaction, use JPEG/WebP at lower quality.
- After interaction stops for ~100–250 ms, send a lossless PNG or higher-quality image.

### Video path

- Use no B-frames.
- Send an IDR keyframe every 1–2 seconds.
- Include SPS/PPS on IDR frames.
- If the browser reports a large `decodeQueueSize`, drop delta frames and force an IDR.
- If queue pressure persists, reduce bitrate, resolution, or FPS.
- Keep latency bounded even if quality degrades.

### Server-side knobs

```text
max_inflight_frames: 1–3
keyframe_interval:   1–2 seconds
target_latency:      30–100 ms local/LAN, higher over WAN
bitrate:             start 8–20 Mbps for 1080p60, tune by content
fps:                 30 or 60
```

---

## 11. Browser display choices

### For image frames

```text
Blob -> createImageBitmap -> OffscreenCanvas 2D
```

This is simple and works well in a worker.

### For WebCodecs video

```text
EncodedVideoChunk -> VideoDecoder -> VideoFrame -> OffscreenCanvas 2D
```

For higher-performance composition, later use:

```text
VideoFrame -> WebGL texture
VideoFrame -> WebGPU external texture, when available and compatible
```

Start with `drawImage(frame, ...)`; optimize only after measuring.

---

## 12. Capability negotiation

At connection start, the browser should report what it can support:

```ts
async function getCapabilities() {
  const caps: string[] = ["image/jpeg", "image/png"];

  if ("VideoDecoder" in globalThis) {
    const h264 = await VideoDecoder.isConfigSupported({
      codec: "avc1.42E01F",
      codedWidth: 1280,
      codedHeight: 720,
    });
    if (h264.supported) caps.push("webcodecs/h264-annexb");
  }

  return caps;
}
```

Server selection policy:

```text
If client supports WebCodecs/H.264 and server has NVENC:
  choose NVIDIA H.264
else if client supports WebCodecs/H.264 and server has PyAV/libx264:
  choose PyAV H.264
else:
  choose JPEG/PNG image path
```

---

## 13. Development milestones

### Milestone 1: image transport

- Implement `RawFrame`, `EncodedPayload`, `ImageEncoder`.
- Implement binary envelope.
- Implement WebSocket session.
- Implement JS worker drawing JPEG/PNG to OffscreenCanvas.
- Implement pointer/resize events.

### Milestone 2: PyAV/WebCodecs video transport

- Add `PyAvH264Encoder`.
- Add WebCodecs worker.
- Verify Annex B payload and keyframe startup.
- Add queue-size ACKs.
- Add periodic keyframes.

### Milestone 3: NVIDIA host-memory path

- Add PyNvVideoCodec host-memory NV12 input.
- Add CPU RGB/RGBA -> NV12 conversion for debugging.
- Compare latency and CPU load against PyAV.

### Milestone 4: NVIDIA GPU-memory path

- Produce CUDA NV12 buffers directly.
- Pass CUDA buffer object into PyNvVideoCodec.
- Avoid GPU->CPU raw frame readback.
- Add forced IDR + SPS/PPS on reconnect/drop.

### Milestone 5: OpenGL integration

- Prototype OpenGL framebuffer readback to CPU first.
- Replace with CUDA-GL interop or GStreamer GL/CUDA path.
- Measure copy cost and end-to-end latency.

---

## 14. Testing plan

### Server tests

- Binary envelope round trip.
- Image encoder outputs valid JPEG/PNG.
- PyAV encoder produces nonempty packets.
- First video chunk after connect is keyframe.
- Forced keyframe request results in IDR/SPS/PPS.
- Session never queues more than `max_inflight` frames.

### Browser tests

- `VideoDecoder.isConfigSupported` result logged.
- Decoder starts from first keyframe.
- Resize works without tearing down the page.
- Worker does not leak `VideoFrame`, `ImageBitmap`, Blob URLs, or canvases.
- Pointer/key/wheel events are normalized and delivered.

### Performance metrics

Track these per client:

```text
encode_ms
payload_bytes
send_queue_depth
round_trip_ack_ms
decoder_decodeQueueSize
frames_displayed_per_second
frames_dropped_server
frames_dropped_client
```

---

## 15. Recommendations

For this project, build in this order:

1. **JPEG/PNG WebSocket** for correctness and easy embedding everywhere.
2. **PyAV/libx264 + WebCodecs** for CPU fallback and proving the video protocol.
3. **PyNvVideoCodec host-memory input** for easy NVENC acceleration.
4. **PyNvVideoCodec CUDA input** for the real high-performance CUDA path.
5. **OpenGL/CUDA interop or GStreamer** only after you measure and know raw readback is too expensive.

The final architecture should not choose only one transport. It should expose one RFB API and let the session negotiate the best available backend.

---

## 16. Reference links

- PyAV installation docs: https://pyav.org/docs/develop/overview/installation.html
- PyAV video frame API: https://pyav.org/docs/develop/api/video.html
- PyAV codec API: https://pyav.org/docs/develop/api/codec.html
- WebCodecs API: https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- WebCodecs usage guide: https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API
- WebCodecs AVC/H.264 registration: https://www.w3.org/TR/webcodecs-avc-codec-registration/
- OffscreenCanvas: https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- VideoFrame: https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame
- PyNvVideoCodec programming guide: https://docs.nvidia.com/video-technologies/pynvvideocodec/pynvc-api-prog-guide/index.html
- PyNvVideoCodec API reference: https://docs.nvidia.com/video-technologies/pynvvideocodec/pynvc-api-reference/index.html
- GStreamer nvcodec plugin docs: https://gstreamer.freedesktop.org/documentation/nvcodec/index.html
- GStreamer nvh264enc docs: https://gstreamer.freedesktop.org/documentation/nvcodec/nvh264enc.html
