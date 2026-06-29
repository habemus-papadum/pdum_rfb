# Remote Framebuffer

`pdum.rfb` streams rendered frames from Python to a browser over WebSocket and
delivers pointer/keyboard/resize events back. It is **transport-neutral**: a
session wires together three independent concerns —

```text
Frame source      -> produces raw frames (NumPy today; CUDA/OpenGL later)
Encoder backend   -> image (JPEG/PNG/WebP) or CPU H.264 (PyAV/libx264)
Transport backend -> WebSocket + a JSON/binary wire protocol
```

The browser client decodes frames **inside a Web Worker** (so the main thread
stays free) and is framework-agnostic: a single `RemoteFramebufferView` class
that React/Vue/Svelte/vanilla can drop in.

> **Where to go next:** the [Python Guide](guide_python.md) (producing/serving
> frames), the [JavaScript Guide](guide_javascript.md) (embedding the client), and
> [Internals](internals.md) (wire protocol, session loop, worker design). The
> original [implementation guide](remote_framebuffer_implementation_guide.md) and
> [addendum](remote_framebuffer_addendum.md) capture the design rationale.

## Install

```bash
uv add habemus-papadum-rfb          # image path only
uv add 'habemus-papadum-rfb[h264]'  # + CPU H.264 (PyAV/libx264)
```

## Python: serve frames

Any `render(seq, timestamp_us) -> np.ndarray` (RGB `(H, W, 3)` uint8) becomes a
source:

```python
import asyncio
import numpy as np
from pdum.rfb import RenderCallbackSource, serve

def render(seq, t_us):
    arr = np.zeros((480, 640, 3), dtype=np.uint8)
    arr[:, (seq * 4) % 640 :] = (40, 160, 220)  # a moving band
    return arr

async def main():
    server = await serve(lambda: RenderCallbackSource(render, width=640, height=480, fps=30))
    async with server as s:
        await s.serve_forever()

asyncio.run(main())
```

The server negotiates the best backend from the client's `hello`: H.264 when the
browser's WebCodecs decoder supports `avc1` and PyAV is installed, otherwise the
image path. To try it immediately with a built-in synthetic pattern:

```bash
uv run python -m pdum.rfb.server --pattern bouncing_box
```

## JavaScript: display frames

```ts
import { RemoteFramebufferView } from "pdum-rfb-widgets";

const view = new RemoteFramebufferView(document.getElementById("stage")!, {
  url: "ws://localhost:8765",
  onStats: (s) => console.log(s.framesDisplayed, s.transport),
});
// later: view.dispose();
```

The worker is bundled inline, so this works with any bundler (or none). For
strict-CSP sites that disallow `blob:` workers, pass your own
`workerFactory: () => new Worker(new URL("pdum-rfb-widgets/worker", import.meta.url), { type: "module" })`.

## Headless testing

Everything is verifiable without a display or manual clicking, in three layers:

1. **Python** (`uv run pytest`) — protocol round-trips, image encoder validity,
   session backpressure/keyframe invariants, and — for H.264 — the produced
   Annex B bitstream is **decoded back with PyAV** to prove it is valid, with no
   browser involved.
2. **JS unit** (`pnpm -C widgets test`) — Vitest covers the protocol (asserted
   byte-for-byte against Python-generated fixtures), event normalization, and
   backpressure logic.
3. **Browser e2e** (`pnpm -C widgets e2e`) — Playwright + headless Chromium boots
   the Python server (streaming a deterministic test pattern) and the demo page,
   decodes real frames, **reads back canvas pixels** and compares them against a
   locally computed expectation, and injects real pointer/keyboard events that it
   verifies the server received. The image path always runs; the H.264 path is
   gated on `VideoDecoder.isConfigSupported` and skipped-with-log where the
   browser build lacks `avc1`.
