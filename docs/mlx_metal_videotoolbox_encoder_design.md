# MLX/Metal Frame Generation to VideoToolbox Encoder Pipeline

_Date: 2026-06-30_

> **Status: v1 shipped & tested.** The encoder ships as the workspace package
> **`packages/vtenc/`** — `habemus-papadum-vtenc` (`import pdum.vtenc`), behind the optional
> `[mac-vt]` extra. It mirrors `packages/nvenc/`: a thin pybind11/Objective-C++ binding over
> `VTCompressionSession` that takes a **host-visible NV12** buffer (numpy or an evaluated MLX
> `mx.array` — both expose the buffer protocol) and returns low-latency **H.264 Annex B**
> (in-band SPS/PPS, no frame reordering, synchronous 1-in-1-out, BT.601 limited-range VUI).
> Tested two ways: `tests/test_vtenc.py` (numpy NV12 → encode → PyAV decode-back, skips off
> macOS) and the **end-to-end MLX driver** `examples/mlx_vt_stream.py` (two `mx.fast.metal_kernel`s
> render RGBA + convert RGB→NV12, encode, decode-back). This corresponds to **Level 1 /
> Milestones 1–3** below (CPU-visible NV12 copy into an encoder-owned `CVPixelBuffer`).
>
> Two deltas from the original draft, found while building it:
> 1. **Input is NV12, not RGBA** — the shim mirrors `pdum.nvenc`'s "NV12 in → Annex B out"
>    contract; the RGB→NV12 conversion lives upstream in MLX (the analog of `gpu.rgb_to_nv12`).
> 2. **The advertised codec string is derived from the emitted SPS, not hardcoded** —
>    VideoToolbox's `Baseline_AutoLevel` picks the level from the resolution, so 1080p is
>    `avc1.420028` (level 4.0), 720p is `avc1.42001F` — `VtEncoder.codec_string` reports the
>    real value.
>
> **Shipped since:** the full **MLX → `serve()` ingress path** is now first-class.
> `display.publish(mlx_rgba)` is recognized as a `memory="metal"` frame (`pdum.rfb.metal`), and
> `serve(gpu=True)` on macOS selects VideoToolbox and converts **RGB(A)→NV12 on the GPU** with a
> custom `mx.fast.metal_kernel` — **~0.28 ms vs ~6.6 ms** for the numpy path at 1080p (23×, and
> off the CPU). Image-only viewers still work via `metal.MetalHostFrameAdapter`. See
> [`guide_python.md`](guide_python.md#mlx-apple-metal-frames-macos). Two things were
> **investigated and measured to not be worth it** on Apple Silicon: input **zero-copy** (the
> next section — the residual `CVPixelBuffer` copy is ≤2 % of frame time) and **pipelined
> encode** (VideoToolbox's low-latency RC is synchronous — see
> [`pipelined_encode.md`](pipelined_encode.md)). Both `encode_pipeline_depth` and the zero-copy
> variants exist/were prototyped but confer no speedup here; 1-in-1-out + GPU-convert is optimal.

## Measured: is input zero-copy worth it on Apple Silicon? (no)

The v1 input path does a CPU `memcpy` of host NV12 into the encoder's `CVPixelBuffer`. The
proposed "zero-copy" milestone was to eliminate that copy (wrap MLX's unified-memory buffer
as the pixel-buffer backing, or convert directly into an IOSurface). Before building it, we
measured (`examples/mlx_vt_bench.py`; `VtEncoder.last_copy_ms` / `last_encode_ms` instrument
the binding; M-series, macOS 26, MLX 0.31):

| Resolution | render (MLX) | convert RGB→NV12 (MLX) | **copy → CVPixelBuffer** | VT encode (sync) | encode() total | **copy %** | fps |
| ---------- | ------------ | ---------------------- | ------------------------ | ---------------- | -------------- | ---------- | --- |
| 1280×720   | 0.99 ms      | 0.36 ms                | **0.041 ms**             | 5.61 ms          | 5.67 ms        | **0.7 %**  | 142 |
| 1920×1080  | 1.08 ms      | 0.44 ms                | **0.106 ms**             | 5.83 ms          | 5.97 ms        | **1.8 %**  | 134 |
| 2560×1440  | 1.15 ms      | 0.52 ms                | **0.187 ms**             | 9.33 ms          | 9.55 ms        | **2.0 %**  | 89  |
| 3840×2160  | 1.28 ms      | 0.63 ms                | **0.383 ms**             | 18.92 ms         | 19.35 ms       | **2.0 %**  | 47  |

**Conclusion: the input copy is 0.7–2.0 % of the encode — not worth optimizing.** Unified
memory already removes the expensive part the CUDA zero-copy path eliminated (the PCIe
host→device upload; see `gpu_zerocopy.md`'s 2.4–4.3× — that win simply does not exist here).
What's left is a sub-0.4 ms RAM `memcpy` even at 4K. The deeper variants (`iosurface-blit`,
or a shim-owned `metal-convert` that would *reverse* the NV12-in contract) would buy ≤2 %.
**Not pursued.** The v1 host-copy path stays.

**The real lever is the *output* side.** Note `VT encode` is a near-flat ~5.6 ms floor at
720p **and** 1080p (2.25× the pixels, ~same time) before compute starts to dominate at
1440p/4K — i.e. at typical sizes the cost is the **synchronous `CompleteFrames` latency**,
not pixel throughput. The 1-in-1-out mode waits out that fixed encoder latency every frame,
so sustained fps is latency-bound. A pipelined encode (depth > 1) would overlap it and raise
throughput substantially — that is the optimization worth doing, and it needs the
token-based seq attribution described in
[`encoder_sync_and_seq_attribution.md`](encoder_sync_and_seq_attribution.md). Zero-copy was
the wrong tree; pipelining is the right one.

## Executive summary

The basic idea is viable, but the correct mental model is:

```text
MLX custom Metal kernels generate image arrays
        ↓
Native shim receives an MLX array / buffer view
        ↓
Native Metal code copies/converts that buffer into an encoder-owned CVPixelBuffer
        ↓
VideoToolbox encodes CVPixelBuffer → compressed CMSampleBuffer
        ↓
Shim packetizes H.264/HEVC for a remote viewer
```

The important correction is that VideoToolbox does **not** encode arbitrary MLX arrays, arbitrary `MTLBuffer`s, or arbitrary `MTLTexture`s. Its compression path is centered on `CVPixelBuffer` input and `CMSampleBuffer` output. So the custom component should be described as an **MLX-aware VideoToolbox encoder shim**, not as a pure “MLX video encoder.”

The most practical production architecture is not immediate zero-copy from MLX to the hardware encoder. It is a staged design:

1. Start with an easy CPU-visible copy path.
2. Move RGB/BGRA → NV12 conversion into native Metal.
3. Import MLX’s Metal-backed buffer into the native shim, if feasible.
4. Treat true encoder-owned MLX arrays backed by `CVPixelBuffer` / `IOSurface` memory as an advanced/research track.

## Source-grounded facts

- MLX supports custom Metal kernels from Python and C++ APIs through `mx.fast.metal_kernel`.
- MLX uses lazy evaluation; computation is recorded until evaluation is forced with `mx.eval`, implicit array printing, NumPy conversion, or memory access.
- MLX supports conversion with the Python buffer protocol and DLPack, but practical Metal-buffer interop is still less mature than CUDA-style array interop.
- DLPack has a `kDLMetal` device type, and its C API describes the tensor data pointer for Metal as an `id<MTLBuffer>`.
- VideoToolbox compression uses `VTCompressionSession`; the encoder takes `CVPixelBuffer`s as input and returns compressed `CMSampleBuffer`s.
- Apple’s low-latency VideoToolbox guidance emphasizes real-time H.264 operation, no frame reordering, and one-in/one-out style behavior for low latency.

## Conceptual corrections to the previous draft

### 1. MLX arrays are not Metal textures

MLX custom kernels operate over array buffers. That is a good fit for image-generation kernels that write `[height, width, channels]` arrays, but it is not the same as rendering into a `MTLTexture`.

This distinction matters because many Apple video paths use `CVPixelBuffer` → `IOSurface` → `CVMetalTexture` / `MTLTexture` as the graphics bridge. DLPack’s Metal representation is a buffer handle, not a texture handle. So DLPack is not, by itself, a clean bridge from MLX arrays to `CVPixelBuffer` planes.

### 2. `CVPixelBuffer` is the hard boundary

The encoder-facing object should be a `CVPixelBuffer`, typically from a `CVPixelBufferPool`. VideoToolbox can internally convert some pixel formats, but relying on implicit conversion can introduce hidden copies and latency. The native shim should explicitly manage pixel format and conversion.

### 3. “Zero-copy” should be defined narrowly

On Apple Silicon, unified memory removes the discrete-GPU PCIe readback cost, but it does not mean every transition is free. CPU access may force synchronization. Pixel-format conversion may allocate or copy. Moving from MLX’s buffer layout to VideoToolbox’s preferred pixel-buffer layout may still require a GPU copy/conversion.

A realistic optimized target is:

```text
MLX Metal buffer → native Metal conversion kernel → encoder-owned CVPixelBuffer → VideoToolbox
```

That is not literally zero-copy, but it avoids a CPU readback and keeps the expensive format conversion on GPU/Metal.

### 4. Encoder-owned MLX buffers are not the first implementation

The previous draft proposed:

```text
encoder.acquire_mlx_frame() → MLX-compatible array backed by encoder-owned CVPixelBuffer memory
```

That is attractive but speculative. It would require either:

- MLX to wrap a native `MTLBuffer`/DLPack object created by the shim;
- the shim to create MLX C++ arrays directly and return them to Python;
- or a custom MLX extension mechanism that can allocate/write compatible memory.

This is feasible as a research direction, but not the shortest robust path. The first production-like version should let MLX own the rendered frame and let the shim copy/convert it into an encoder-owned pool.

## Proposed architecture

```text
Python control plane
  |
  | render_frame_mlx(t) -> mx.array[H, W, 4]
  v
MLX array frame, preferably uint8 BGRA/RGBA or float16/float32 RGBA
  |
  | encode(frame, pts_ns)
  v
Native extension boundary
  |
  | validate shape/dtype/contiguity
  | force or require completed MLX evaluation
  | import buffer via buffer protocol, MLX C++ API, or DLPack/Metal path
  v
Native Metal stage
  |
  | convert RGBA/BGRA/float -> NV12 or BGRA CVPixelBuffer
  v
CVPixelBufferPool / CVPixelBuffer
  |
  | VTCompressionSessionEncodeFrame(pixelBuffer, pts)
  v
CMSampleBuffer callback
  |
  | extract parameter sets and encoded NAL units
  | convert AVCC length-prefixed NAL units to Annex B if desired
  v
EncodedPacket stream for remote viewer
```

## Python-facing API

The public Python API should hide VideoToolbox and CoreFoundation lifetimes.

```python
from dataclasses import dataclass
import mlx.core as mx
from mlx_vt_encoder import MLXVideoToolboxEncoder

@dataclass
class EncodedPacket:
    data: bytes
    pts_ns: int
    dts_ns: int | None
    is_keyframe: bool
    is_codec_config: bool
    codec: str          # "h264" or "hevc"
    packet_format: str  # "annexb" or "avcc"

encoder = MLXVideoToolboxEncoder(
    width=1280,
    height=720,
    fps=60,
    codec="h264",
    bitrate=8_000_000,
    realtime=True,
    low_latency=True,
    input_format="rgba8",       # what MLX produces
    encoder_format="nv12",      # what native shim feeds VideoToolbox
    packet_format="annexb",     # convenient for custom streaming
    max_in_flight_frames=2,
)

for i in range(num_frames):
    t = i / 60.0
    frame = render_frame_mlx(1280, 720, t)  # mx.array[H, W, 4]

    # MLX is lazy. Either the encoder calls this internally, or the contract
    # requires callers to do it before encode().
    mx.eval(frame)

    packets = encoder.encode(frame, pts_ns=i * 1_000_000_000 // 60)
    for packet in packets:
        send_to_remote_viewer(packet)

for packet in encoder.flush():
    send_to_remote_viewer(packet)

encoder.close()
```

## MLX rendering kernel example

This is array generation, not texture rendering.

```python
import mlx.core as mx

source = r"""
uint x = thread_position_in_grid.x;
uint y = thread_position_in_grid.y;

if (x >= width || y >= height) return;

uint idx = (y * width + x) * 4;
float fx = float(x) / float(width);
float fy = float(y) / float(height);

out[idx + 0] = uint8_t(255.0 * fx);                 // R
out[idx + 1] = uint8_t(255.0 * fy);                 // G
out[idx + 2] = uint8_t(128.0 + 127.0 * sin(time));  // B
out[idx + 3] = uint8_t(255);                        // A
"""

render_kernel = mx.fast.metal_kernel(
    name="render_rgba8",
    input_names=[],
    output_names=["out"],
    source=source,
)

def render_frame_mlx(width: int, height: int, t: float) -> mx.array:
    (out,) = render_kernel(
        inputs=[],
        output_shapes=[(height, width, 4)],
        output_dtypes=[mx.uint8],
        grid=(width, height, 1),
        threadgroup=(16, 16, 1),
        template=[("width", width), ("height", height), ("time", float(t))],
    )
    return out
```

## Native shim responsibilities

The native shim should own:

- `VTCompressionSession`.
- `CVPixelBufferPool`.
- `CVMetalTextureCache` when using Metal-visible pixel buffers.
- A Metal device and command queue for conversion/copy kernels.
- Optional pipeline states for:
  - RGBA8/BGRA8 → NV12.
  - float16/float32 RGBA → NV12.
  - RGB/BGR channel swizzle.
  - scaling, if needed.
- Timestamp conversion: nanoseconds ↔ `CMTime`.
- Output callback management.
- Packetization: AVCC/length-prefixed NAL units versus Annex B/start-code NAL units.
- Parameter-set extraction: SPS/PPS for H.264, VPS/SPS/PPS for HEVC.
- Backpressure and in-flight-frame limits.
- Shutdown and flushing.

## Implementation levels

### Level 1: CPU-visible prototype

```text
MLX array
  → mx.eval(frame)
  → NumPy or memoryview access
  → native shim copies bytes into CVPixelBuffer base address
  → VTCompressionSessionEncodeFrame
```

This is the fastest way to validate correctness.

Pros:

- Simple.
- Easy to debug.
- Proves VideoToolbox settings, packetization, transport, and viewer behavior.

Cons:

- CPU access forces synchronization.
- CPU copy is likely too expensive for high-resolution/high-FPS streaming.
- Color conversion on CPU is undesirable.

Use this to get a working `.h264` or `.mp4` test output before optimizing.

### Level 2: Native Metal conversion into CVPixelBuffer

```text
MLX frame buffer
  → native shim obtains a readable buffer view
  → native Metal kernel writes NV12 planes into encoder-owned CVPixelBuffer
  → VTCompressionSessionEncodeFrame
```

This is the recommended first optimized design.

The source may still be imported through a conservative bridge at first, but the important improvement is that RGB/BGRA → NV12 conversion moves into Metal. The destination is a `CVPixelBuffer` allocated from a pool with Metal compatibility and the desired pixel format.

### Level 3: DLPack / `MTLBuffer` source import

```text
MLX array exports/imports DLPack or native MLX C++ array handle
  → native shim sees the source as an MTLBuffer-like resource
  → Metal kernel reads MLX buffer and writes CVPixelBuffer planes
```

This avoids CPU memory access for the source frame, but this is where the current ecosystem is less mature. DLPack has a Metal device type and can represent Metal buffers, but that does not automatically mean MLX, PyTorch MPS, and arbitrary native code all interoperate zero-copy today.

The shim should support multiple import backends:

```text
Backend A: Python buffer protocol / memoryview
Backend B: MLX C++ extension API
Backend C: DLPack kDLMetal import
Backend D: custom capsule exposing native MLX array internals
```

Backend A is easiest. Backend B or C is the likely optimized route. Backend D is brittle unless MLX exposes stable APIs for it.

### Level 4: Encoder-owned frame buffers exposed to MLX

```text
encoder.acquire_frame()
  → returns an MLX-compatible array
  → MLX writes directly into memory owned by the encoder shim
  → encoder submits same backing storage to VideoToolbox
```

This is the ideal end-state but the riskiest. The difficulty is that VideoToolbox wants `CVPixelBuffer`, while MLX wants array-like `MTLBuffer`-style storage. A `CVPixelBuffer` may be IOSurface-backed and Metal-texture-compatible, but that does not automatically make it a linear `MTLBuffer` that MLX can wrap as an array.

Keep this as a research milestone, not the primary plan.

## Pixel formats

### Input from MLX

Recommended first input format:

```text
shape: [height, width, 4]
dtype: uint8
layout: row-contiguous
semantic format: RGBA8 or BGRA8
```

Alternative input format:

```text
shape: [height, width, 4]
dtype: float16 or float32
range: 0.0 to 1.0
semantic format: linear or sRGB-ish RGBA
```

Float input is convenient for rendering math but requires quantization and color conversion before encode.

### Encoder input

Recommended encoder pixel format:

```text
NV12 / 420f / 420v-style Y + interleaved UV
```

Reasons:

- Good fit for H.264/HEVC hardware encoding.
- Avoids hidden RGB → YUV conversion inside VideoToolbox.
- Makes color range and matrix decisions explicit.

BGRA may be useful for early versions, but it risks implicit conversion in VideoToolbox.

## Color handling

The shim should make these decisions explicit:

```text
Input assumption: sRGB-like RGB
HD matrix: BT.709
Range: video range or full range, but choose one deliberately
Alpha: ignored unless a nonstandard path needs it
```

For remote viewing, mismatched color range is a common source of washed-out or over-contrasty output. Encode metadata and browser decoder expectations should agree.

## Synchronization model

MLX is lazy, so the encoder must not read a frame until MLX work has completed.

Conservative API rule:

```python
mx.eval(frame)
packets = encoder.encode(frame, pts_ns)
```

The encoder can call `mx.eval(frame)` internally for ergonomics, but for performance testing it is better to make evaluation explicit so the application controls batching.

For the native Metal conversion path, the shim must also order its own command buffer correctly:

```text
MLX render complete
  → native Metal copy/conversion command buffer submitted
  → conversion complete
  → VTCompressionSessionEncodeFrame called with the filled CVPixelBuffer
```

If the shim cannot share MLX’s stream/command-queue synchronization primitive, it should use a conservative synchronization boundary at `encode()`.

## VideoToolbox settings

For low-latency remote viewing, configure the compression session approximately as follows:

```text
codec: H.264 first; HEVC later
RealTime: true
AllowFrameReordering: false
MaxFrameDelayCount: 1, if supported
ExpectedFrameRate: fps
AverageBitRate: configured target
KeyFrameInterval: e.g. 1–2 seconds
ProfileLevel: H.264 baseline/main/high depending browser needs
```

H.264 is usually the safest first codec for browser/client compatibility. HEVC may be attractive on Apple clients but has more compatibility caveats on browsers and non-Apple platforms.

## Packetization

VideoToolbox returns compressed frames as `CMSampleBuffer`s. For H.264/HEVC, the sample data is typically in MP4-style length-prefixed NAL units, while many custom streaming transports prefer Annex B start-code-delimited NAL units.

The shim should expose a single packet format.

Recommended first format:

```text
Annex B H.264
```

The shim should:

- Extract SPS/PPS from the sample buffer’s format description.
- Emit codec-config packets at stream start.
- Optionally prepend SPS/PPS before every keyframe.
- Convert length-prefixed NAL units to start-code-delimited NAL units.
- Mark keyframes.
- Preserve presentation timestamps.

## Backpressure and frame dropping

The encoder is asynchronous. A call to `encode(frame)` may return no packet, one packet, or packets from earlier frames.

Recommended behavior:

```python
packets = encoder.encode(frame, pts_ns)
```

Internally:

- Keep at most `max_in_flight_frames` frames queued.
- If the encoder is behind, either block briefly or drop the newest/oldest frame according to a configured policy.
- For live remote viewing, dropping stale frames is usually better than building latency.

Potential policies:

```text
block
fail_fast
drop_new
drop_old
```

For interactive remote rendering, `drop_old` or `fail_fast` is usually preferable to unbounded buffering.

## Threading model

A good native layout is:

```text
Python thread
  → calls encode()
  → native shim validates input and queues conversion

Native Metal queue
  → RGB/BGRA/float → NV12 conversion

VideoToolbox callback queue
  → receives CMSampleBuffers
  → packetizes
  → app pulls packets or callback pushes packets
```

Keep Python callbacks out of the VideoToolbox callback thread if possible. Buffer packets in native code and let Python poll/drain them, or invoke Python callbacks only from a controlled GIL-aware dispatch point.

## Remote viewer boundary

The remote viewer is out of scope, but the encoder should produce a transport-neutral packet stream:

```python
@dataclass
class EncodedPacket:
    data: bytes
    pts_ns: int
    is_keyframe: bool
    is_codec_config: bool
    codec: str
    packet_format: str
```

The transport layer can then choose:

```text
WebSocket binary messages
WebTransport datagrams/streams
WebRTC encoded frame injection, if applicable
MSE/WebCodecs-oriented framing
custom native viewer protocol
```

Do not bake WebSocket/WebTransport assumptions into the encoder shim.

## Suggested implementation stack

### Native shim language

Best candidates:

```text
Objective-C++ + pybind11
Swift + C ABI + Python extension wrapper
Rust + objc2/core-video/video-toolbox bindings + PyO3
```

Objective-C++ is probably the most direct for Apple frameworks plus C++ MLX integration. Rust is attractive if you want a safer long-term library, but Apple media APIs are more verbose from Rust.

### Python package layout

```text
mlx_vt_encoder/
  __init__.py
  _encoder_ext.*.so
  encoder.py
  packets.py
  test_patterns.py
native/
  Encoder.mm
  PixelBufferPool.mm
  MetalConverter.mm
  Packetizer.mm
  mlx_bridge.cpp
  CMakeLists.txt or setup.py/scikit-build config
examples/
  render_gradient.py
  save_h264.py
  stream_websocket.py
```

## Validation plan

### Test 1: static color bars

- Generate known RGB color bars in MLX.
- Encode H.264.
- Decode with ffmpeg or AVFoundation.
- Compare approximate colors.

### Test 2: timestamp monotonicity

- Encode 300 frames at 60 FPS.
- Verify strictly increasing PTS.
- Verify no duplicate timestamps.

### Test 3: keyframe behavior

- Configure 1-second keyframe interval.
- Verify keyframes appear at expected cadence.
- Verify SPS/PPS are emitted at stream start and before keyframes if configured.

### Test 4: latency

Measure:

```text
MLX render time
MLX eval/sync time
native conversion time
VTCompressionSession input-to-callback latency
packetization time
transport enqueue time
```

### Test 5: backpressure

- Artificially slow the remote transport.
- Confirm latency stays bounded.
- Confirm frame-drop policy works.

## Recommended milestones

### Milestone 1: minimal VideoToolbox encoder

Input: NumPy `uint8` BGRA/RGBA frames.

Output: `.h264` Annex B elementary stream.

Goal: prove `VTCompressionSession`, packetization, keyframes, and timestamps.

### Milestone 2: MLX frame source with CPU-visible copy

Input: MLX custom-kernel-generated array.

Path: `mx.eval(frame)` → `np.array(frame)` or memoryview → native copy.

Goal: prove MLX-generated frames encode correctly.

### Milestone 3: native Metal conversion

Input: MLX frame, still imported conservatively if needed.

Path: native Metal conversion into NV12 `CVPixelBuffer`.

Goal: remove CPU color conversion and prepare for GPU-side source import.

### Milestone 4: MLX buffer import

Input: MLX array imported through MLX C++ API or DLPack/Metal path.

Path: `MTLBuffer`-like source → Metal conversion kernel → `CVPixelBuffer`.

Goal: avoid CPU-touching the rendered frame.

### Milestone 5: low-latency streaming integration

Output: packet stream into remote viewer transport.

Goal: measure and tune end-to-end latency.

### Milestone 6: encoder-owned frame pool research

Investigate whether native-created Metal buffers or IOSurface-backed storage can be wrapped as MLX arrays safely and stably.

Goal: reduce allocation churn and possibly eliminate one copy/conversion stage.

## Main risks

### Risk: MLX interop APIs are not stable enough

Mitigation: keep the CPU-visible path working and isolate the optimized import path behind a backend interface.

### Risk: hidden VideoToolbox conversion copies

Mitigation: explicitly allocate pixel buffers with desired pixel format and attributes; explicitly convert to NV12 before encode.

### Risk: synchronization stalls dominate

Mitigation: use a small ring of frame buffers, avoid CPU memory access, and keep conversion/encode asynchronous once correctness is proven.

### Risk: color mismatch in browser viewer

Mitigation: choose BT.709 and range explicitly; test decoded output; include color metadata where the container/protocol supports it.

### Risk: packet format mismatch

Mitigation: make `packet_format` explicit and test with both a file decoder and the intended remote viewer.

## Bottom line

The revised design should be:

```text
MLX renders arrays with custom Metal kernels.
A native MLX-aware VideoToolbox shim imports those arrays.
The shim converts/copies into encoder-owned CVPixelBuffers, preferably using Metal.
VideoToolbox encodes those CVPixelBuffers.
The shim packetizes compressed samples for a separate remote-viewer transport.
```

The first optimized target should be **GPU-side conversion from an MLX-owned array buffer into an encoder-owned NV12 CVPixelBuffer**. Do not make the first version depend on MLX directly rendering into `CVPixelBuffer`/`IOSurface` storage; that path is attractive but considerably more speculative.

## References

- MLX custom Metal kernels documentation: https://ml-explore.github.io/mlx/build/html/dev/custom_metal_kernels.html
- MLX `metal_kernel` API reference: https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.fast.metal_kernel.html
- MLX lazy evaluation documentation: https://ml-explore.github.io/mlx/build/html/usage/lazy_evaluation.html
- MLX conversion to NumPy and other frameworks: https://ml-explore.github.io/mlx/build/html/usage/numpy.html
- DLPack C API, including `kDLMetal` and Metal data pointer semantics: https://dmlc.github.io/dlpack/latest/c_api.html
- DLPack Python specification: https://dmlc.github.io/dlpack/latest/python_spec.html
- MLX issue discussing Metal-backed DLPack consumer support: https://github.com/ml-explore/mlx/issues/3548
- Apple VideoToolbox documentation: https://developer.apple.com/documentation/videotoolbox
- Apple WWDC 2014 “Direct Access to Video Encoding and Decoding”: https://developer.apple.com/videos/play/wwdc2014/513/
- Apple WWDC 2021 “Explore low-latency video encoding with VideoToolbox”: https://developer.apple.com/videos/play/wwdc2021/10158/
- Apple CoreVideo `CVMetalTextureCache` documentation: https://developer.apple.com/documentation/corevideo/cvmetaltexturecache-q3j
- Apple CoreVideo `kCVPixelBufferMetalCompatibilityKey` documentation: https://developer.apple.com/documentation/corevideo/kcvpixelbuffermetalcompatibilitykey
