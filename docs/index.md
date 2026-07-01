# pdum.rfb — Remote Frame Buffer

`pdum.rfb` (PyPI: **`habemus-papadum-rfb`**) streams a server-rendered framebuffer
to a browser over a WebSocket, with pointer/keyboard/resize events flowing back.
You **render in Python** and **view and interact in the browser**. The target is
scientific and interactive visualization across the whole cadence range — from
**sparse, on-demand scenes** (render only when state changes) to **high-frame-rate
streaming** (low-latency H.264/WebCodecs, GPU-rendered). You own the loop and the
cadence; the library never imposes a fixed game-engine tick. It is **not** a generic
VNC clone.

The project ships two halves:

- a **Python server** — the `pdum.rfb` package (Python **3.14+**, UV-managed);
- a **browser client** — `@habemus-papadum/rfb-widgets`, a TypeScript package whose
  decoding runs entirely in a **Web Worker** that owns the WebSocket, the decoder,
  and a transferred `OffscreenCanvas`, keeping your main thread free.

## Compared to `jupyter_rfb`

[`jupyter_rfb`](https://github.com/vispy/jupyter_rfb) pioneered "render in Python, view in
the browser" for notebooks, and `pdum.rfb` speaks the same
[renderview event vocabulary](proposals/completed/rendercanvas_backend.md) — so it drops in under
`rendercanvas` / `pygfx` / `fastplotlib`. Three differences shape it:

- **Not tied to Jupyter.** Frames travel over a plain WebSocket, not ipywidgets/kernel
  comms. The same server drives a standalone web page, a desktop webview, or a fully
  headless box — no notebook or kernel in the loop.
- **Built for high frame rates.** Beyond the per-frame image path (every frame a keyframe,
  like `jupyter_rfb`), a low-latency **H.264/WebCodecs** path adds per-client backpressure
  and a keyframe policy — made for continuous, interactive framerates, not just the
  occasional redraw.
- **Hardware encode on the GPU.** When you render on CUDA, frames can go **straight to
  NVENC** (CUDA NV12 → H.264) without a host round-trip — via PyAV's `h264_nvenc` or the
  PyAV-free `pdum.nvenc` encoder. On **Apple Silicon** the same `serve(gpu=True)` drives
  **VideoToolbox** from an MLX render, with the color conversion on the GPU. See
  [CUDA→NVENC](gpu_zerocopy.md) and [Apple Metal / VideoToolbox](metal_videotoolbox.md).

Whether you push every 16 ms or once a minute is entirely up to your loop.

## The mental model: push

The public API is **push**. You own your loop and publish frames into a shared
`Display`; the library fans each frame out to every connected viewer, and you drain
input from all viewers in one place.

```text
your loop ── display.publish(ndarray) ─►  Display (latest frame, +version)
   ▲                                         │  one RfbSession + encoder per viewer,
   └── for ev in display.poll_events()       └─► fed the latest frame, negotiating
       (input from all viewers)                  image vs H.264 per client
```

```python
import asyncio
import pdum.rfb as rfb

async def main():
    display = await rfb.serve(1280, 720, port=8765)   # WS server starts in the background
    state = initial_state()
    try:
        while running(state):
            for ev in display.poll_events():           # input from every viewer
                state = update(state, ev)              # ev.client_id, ev.principal, ev.event
            display.publish(render(state))             # sync, non-blocking, latest-wins, fans out
            await asyncio.sleep(1 / 30)                # or on-demand, or every 60s — you own the cadence
    finally:
        await display.aclose()

asyncio.run(main())
```

`publish()` is synchronous (it stores the latest frame, bumps a version, and wakes
each viewer's session) and must run on the event-loop thread. A viewer that falls
behind simply skips intermediate frames. The pull-based `FrameSource` model still
exists, but it is **internal** now (each connection's session pulls from a private
`_ClientFeed`).

Try it instantly with a built-in pattern, no client code:

```bash
uv run python -m pdum.rfb.server --pattern bouncing_box --port 8765
```

…and on the browser side:

```ts
import { RemoteFramebufferView } from "@habemus-papadum/rfb-widgets";
const view = new RemoteFramebufferView(document.getElementById("stage")!, {
  url: "ws://localhost:8765",
});
// later: view.dispose();
```

## Two transports, one negotiation

A connecting browser advertises what it can decode; the server picks the best
shared path per client.

- **Image path** — one independent image per frame (JPEG/PNG/WebP via Pillow); every
  frame is a keyframe. Ideal for stills, snapshots, and a lossless final frame.
  Dependency-light (numpy, pillow, websockets).
- **H.264 path** — CPU H.264 via PyAV/libx264 (the `[h264]` extra), emitting
  **Annex B** access units for the browser's WebCodecs `VideoDecoder`. Configured
  for low latency (`ultrafast`/`zerolatency`, no B-frames, ~1 s IDR cadence,
  in-band SPS/PPS). `import pdum.rfb` works without the extra — PyAV loads lazily.

For GPU-rendered scenes on **Linux/NVIDIA** there are three hardware NVENC paths,
fastest-installed first: the **PyAV-free NVENC SDK** wheel (`habemus-papadum-nvenc`),
the **zero-copy CUDA→NVENC** path (CuPy/DLPack → `h264_nvenc`, PyAV ≥ 18), and
**host-memory NVENC** (PyAV's bundled `h264_nvenc`). On **macOS/Apple Silicon**,
`serve(gpu=True)` instead drives Apple **VideoToolbox** from an MLX render (GPU
RGB→NV12). `serve(gpu=True)` picks the right backend for the platform. See
[Installation](installation.md), [Performance](performance.md), and the
[CUDA→NVENC](gpu_zerocopy.md) / [Apple Metal](metal_videotoolbox.md) guides.

## Verified headlessly, end to end

Every layer is testable without a display or manual clicking:

1. **pytest** — protocol round-trips (+ golden fixtures for JS), image-encoder
   validity (re-decoded with Pillow), session invariants (backpressure,
   keyframe-first, latest-frame-wins), negotiation, and H.264 Annex B **decoded
   back with PyAV**.
2. **Vitest** — the TypeScript unpacker asserted byte-for-byte against the
   Python-generated fixtures; event scaling and backpressure logic in isolation.
3. **Playwright** — boots the Python server (deterministic test pattern) + a prod
   demo build, decodes real frames, **reads back canvas pixels**, and injects real
   input it verifies the server received.

## Where to go next

- **[Installation](installation.md)** — image path, CPU H.264, the NVIDIA GPU
  routes, and Apple Silicon, with the platform matrix.
- **[Python Guide](guide_python.md)** — producing/serving frames, events, auth,
  encoders, metrics, adaptive quality, testing helpers.
- **[JavaScript Guide](guide_javascript.md)** — `RemoteFramebufferView`, options,
  framework integration, CSP/worker packaging.
- **[Internals](internals.md)** — data flow, wire protocol, session loop, the H.264
  path, the worker, and the module map.
- **[Repository & Development](development.md)** — repo layout, the uv + pnpm
  conventions, and the GitHub CI / release pipeline.
- **[Performance](performance.md)** · **[Roadmap](roadmap.md)** ·
  **[API Reference](reference.md)**.
