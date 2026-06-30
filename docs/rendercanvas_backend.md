# A `rendercanvas` backend for `pdum.rfb`

> **Status: implemented.** The backend ships as `pdum.rfb.rendercanvas`
> (`RfbRenderCanvas` / `RenderCanvas`), behind the optional `[rendercanvas]` extra. It is
> **cross-platform (macOS + Linux)** — the bitmap present path is a host download, no
> CUDA/NVENC. Bridge-level tests (`tests/test_rendercanvas_backend.py`, present→publish +
> event translation + lifecycle) pass against `rendercanvas` 2.6.3; the full pygfx-on-wgpu
> render round-trip needs a GPU/adapter and is run manually. This doc is the design +
> rationale; for usage see the [Python guide](guide_python.md#the-rendercanvas-backend).

**Question.** This project is similar in spirit to `jupyter_rfb`. The `rendercanvas`
package (the canvas-abstraction layer under `pygfx` / `fastplotlib` / `wgpu`) ships a
backend built on `jupyter_rfb`. Could we write a `rendercanvas` backend that streams
through `pdum.rfb` instead — and could the WebGPU render be fed to NVENC **zero-copy**
(on Linux `wgpu-native` runs on Vulkan; how do we couple that to zero-copy NVENC)?

**Short answer.**

- **A working backend is easy — done.** ~190 lines (`src/pdum/rfb/rendercanvas.py`). It
  mirrors `rendercanvas`'s own `jupyter_rfb`/`offscreen` backends; the only difference is
  the frame sink (`Display.publish()` instead of `RemoteFrameBuffer.send_frame()`) plus a
  small event key-rename shim (below). The payoff over `jupyter_rfb` is real: H.264/
  WebCodecs transport with per-client backpressure instead of per-frame JPEG over
  `ipywidgets`.
- **Zero-copy WebGPU → NVENC is *not* possible with stock `wgpu-py` today.** The
  *encoder half* of that pipeline already exists in this repo (`gpu.rgb_to_nv12` +
  `pdum.nvenc`'s `NvEncoderCuda`). The missing link is purely getting the Vulkan
  image/semaphore handles **out of** `wgpu-py` to import into CUDA — and `wgpu-py`
  exposes no Python API for that. It is a native-extension research spike (comparable
  in scope to the existing `packages/nvenc/`), not a feature you can wire up against
  the public API.

The two questions are independent: ship the (CPU-path) backend now; treat zero-copy as
a separate, speculative track.

---

## 1. What `rendercanvas` is, and why a backend is the right seam

`rendercanvas` (formerly `wgpu.gui`) is "one canvas API, multiple backends." A render
engine (`pygfx`, `fastplotlib`, raw `wgpu`) targets `rendercanvas`'s abstract canvas;
the backend decides *where the pixels go* — a glfw window, Qt/wx widget, an offscreen
numpy buffer, or a remote browser. The notebook story has two backends:

- `rendercanvas.jupyter` — built on **`jupyter_rfb`** (this is the one the question
  refers to). Kept for backwards-compat, now considered deprecated.
- `rendercanvas.pyodide`/anywidget — the modern notebook backend, auto-selected in
  notebooks.

A `pdum.rfb` backend slots in at exactly the same layer: any `wgpu`/`pygfx` app would
render unchanged, and `RenderCanvas` would stream the result to a browser over
`pdum.rfb`'s WebSocket + Web-Worker pipeline. This is strictly a *superset* of the
`jupyter_rfb` value proposition — same "render in Python, view in browser," but with
the H.264 / NVENC transport, multi-client fan-out, and pluggable auth this library
already has.

## 2. How a `rendercanvas` backend works (the contract)

A backend subclasses `BaseRenderCanvas` and implements a set of `_rc_*` methods. The
canonical, copy-this template is `rendercanvas`'s own
[`jupyter.py`](https://github.com/pygfx/rendercanvas/blob/main/rendercanvas/jupyter.py)
and [`offscreen.py`](https://github.com/pygfx/rendercanvas/blob/main/rendercanvas/offscreen.py).
The relevant pieces:

| `_rc_*` method | Role |
| --- | --- |
| `_rc_get_present_info(present_methods)` | Choose a **present method** and return its config dict. Called once, at context creation. |
| `_rc_present_bitmap(data, format, **kwargs)` | Receives the rendered frame as a CPU bitmap (only for the `"bitmap"` method). |
| `_rc_request_draw()` | Ask the loop to schedule a draw (calls back into `_draw_frame_and_present()`). |
| `_rc_set_logical_size(w, h)` / `_rc_get_closed()` / `_rc_close()` / `_rc_set_title()` / `_rc_gui_poll()` | Window/lifecycle plumbing. |
| `submit_event(event)` | Backend → engine: deliver an input event (drives `pygfx` controllers — orbit camera, etc.). |

> ⚠️ `rendercanvas` explicitly documents the backend API as **internal and versioned**
> ("may change with each version without warning"). Pin a `rendercanvas` version and
> track its `jupyter.py` rather than treating these signatures as stable. The names
> above are current as of `rendercanvas` 2.6.x.

**The decisive detail — the `"bitmap"` present method is a GPU→CPU download.** A
backend advertises either `"screen"` (wgpu renders directly into a real OS surface —
useless for a headless server) or `"bitmap"`. `jupyter_rfb` and `offscreen` both use
`"bitmap"`:

```python
def _rc_get_present_info(self, present_methods):
    return {"method": "bitmap", "formats": ["rgba-u8"]}
```

With `"bitmap"`, `wgpu`'s context **renders to a texture and then downloads it to
RAM**, handing the backend a contiguous **`(H, W, 4)` `uint8` RGBA numpy array**. That
array is exactly what `pdum.rfb`'s `Display.publish()` already accepts. There is no
public present method that hands back the *GPU texture* — which is the crux of the
zero-copy question in §5.

## 3. The backend, concretely (as implemented)

`src/pdum/rfb/rendercanvas.py` subclasses `BaseRenderCanvas` with a canvas group bound to
`rendercanvas`'s shared asyncio loop, so its scheduler drives draws and calls
`_rc_gui_poll` regularly. The whole thing is the present bridge + an event pump + the
lifecycle/size methods that `rendercanvas` requires:

```python
from rendercanvas.asyncio import loop
from rendercanvas.base import BaseCanvasGroup, BaseRenderCanvas

class RfbCanvasGroup(BaseCanvasGroup): ...

class RfbRenderCanvas(BaseRenderCanvas):
    _rc_canvas_group = RfbCanvasGroup(loop)          # ← scheduler runs on the asyncio loop

    def __init__(self, *args, display, size=None, **kwargs):
        self._display = display                      # a pdum.rfb Display (from serve())
        self._closed = False
        super().__init__(*args, size=size or (display.width, display.height), **kwargs)
        self._final_canvas_init()

    def _rc_get_present_info(self, present_methods):
        return {"method": "bitmap", "formats": ["rgba-u8"]} if "bitmap" in present_methods else None

    def _rc_present_bitmap(self, *, data, format, **kwargs):
        self._display.publish(np.asarray(data))      # (H, W, 4) uint8 -> existing image/H.264 path

    def _rc_gui_poll(self):                           # called by the scheduler each tick
        for ev in self._display.poll_events():
            rc = _to_rendercanvas_event(ev.event)
            if rc is not None:
                self.submit_event(rc)

    def _rc_request_draw(self):  self._time_to_draw()
    def _rc_force_paint(self):   self._time_to_paint()
    def _rc_request_paint(self): pass                 # virtual canvas: already published
    def _rc_set_logical_size(self, w, h): self._size_info.set_physical_size(int(w), int(h), 1.0)
    def _rc_close(self):      self._closed = True
    def _rc_get_closed(self): return self._closed
```

What makes this small:

1. **`publish()` already speaks RGBA8.** `Display.publish()` accepts `(H, W, 4)`
   `uint8` and tags it `rgba8`; the image encoder (Pillow) and the H.264 encoders
   consume it. No new frame type, no change to `session.py`.
2. **One shared asyncio loop.** The canvas group binds to `rendercanvas`'s `AsyncioLoop`;
   `AsyncioLoop._rc_init` attaches to the *running* loop — the same one `pdum.rfb.serve()`
   started the WebSocket server on. The scheduler then drives draws and pumps events,
   and `publish()` lands on the loop thread it requires.
3. **Bitmap present mirrors `offscreen`; scheduling mirrors `glfw`.** No native surface,
   so `"bitmap"` only and `_rc_request_paint` is a no-op (the frame is already published).

### The one piece of glue: an event key-rename

`pdum.rfb` now emits the [renderview vocabulary](https://github.com/pygfx/renderview)
(`type`, logical coords, `1=left/2=right/3=middle` button, tuple `buttons`, capitalized
`modifiers`). `rendercanvas` 2.x still consumes the *legacy* keys (`submit_event` requires
`event_type`, and it uses `time_stamp`). So `_to_rendercanvas_event` is a **pure
key-rename** — `type → event_type`, `timestamp → time_stamp` — because every *value* is
already in the shared convention:

```python
_FORWARD = {"pointer_move", "pointer_down", "pointer_up", "wheel", "key_down", "key_up"}

def _to_rendercanvas_event(event):
    if event.get("type") not in _FORWARD:        # resize/set_viewport: the canvas owns its size
        return None
    out = dict(event); out["event_type"] = out.pop("type")
    if "timestamp" in out: out["time_stamp"] = out.pop("timestamp")
    return out
```

This is the payoff of the [event-schema migration](#7-should-we-adopt-the-renderview-event-schema):
because we aligned `pdum.rfb` to renderview, the shim is a two-key rename rather than a
button/modifier/coordinate translation table — and it collapses to the **identity** once
`rendercanvas` itself adopts `type` (the migration its own back-compat notes promise).

### What's tested vs. manual

| Item | Status |
| --- | --- |
| present → `publish`, event key-rename + pump, lifecycle | ✅ `tests/test_rendercanvas_backend.py` (vs real `rendercanvas` 2.6.3, no GPU) |
| Full `pygfx`-on-`wgpu` render → browser round-trip | manual (needs a GPU/adapter; macOS + Linux) |

**Verdict: a clear, low-risk feature.** The CPU download in `"bitmap"` present is the
same cost `jupyter_rfb` already pays; we simply replace JPEG-over-ipywidgets with this
library's faster transport.

## 4. Where it lands on the transport spectrum (the cost to be honest about)

The bitmap path is a **GPU→CPU download every frame**:

```
wgpu render (GPU) ── download ──► RGBA numpy (CPU) ── publish() ──► encoder
```

What happens next depends on the encoder the client negotiated:

- **Image transport** — CPU array → Pillow JPEG/PNG/WebP. Fine; CPU-native anyway.
- **CPU H.264** (`libx264`) — CPU array → `yuv420p` reformat → encode. Fine.
- **Host NVENC** (`encoders/nvenc_cpu.py`) — CPU array → **upload back to GPU** → encode.
  This is the wasteful case: the frame crosses PCIe **down then up**. It still works
  and is still faster to *encode* than libx264, but the round-trip is the very thing
  zero-copy would eliminate.

So the bitmap backend is correct and useful immediately, but it does **not** get you
the win documented in [`gpu_zerocopy.md`](gpu_zerocopy.md). For that, read on.

## 5. Zero-copy WebGPU → NVENC

> A concrete, minimal-package design and a 1–2 day de-risking spike for this section
> now live in [`wgpu_nvenc_zerocopy.md`](wgpu_nvenc_zerocopy.md). The short version: the
> handoff *is* buildable — `wgpu-py` can load a patched `wgpu-native` via `WGPU_LIB_PATH`
> — but it needs a small native patch because the `wgpu-native` **C** API exposes no
> Vulkan handles. The rest of this section is the background.

### 5.1 The target pipeline (and how much of it already exists)

```
wgpu render → Vulkan VkImage (external-memory)         ← MISSING: wgpu-py won't export this
   → CUDA import (cuImportExternalMemory)               ← MISSING: needs the handle above
   → RGBA→NV12 CUDA kernel                               ✅ gpu.rgb_to_nv12 (src/pdum/rfb/gpu.py)
   → NvEncoderCuda → Annex B                             ✅ pdum.nvenc (packages/nvenc/)
   → publish()/session → browser WebCodecs              ✅ existing
```

**Three of the four stages are already built and proven in this repo.** This is worth
emphasizing: the project's CUDA encode tail (`rgb_to_nv12`, the contiguous-NV12 layout
contract, `NvencGpuPdumEncoder`, `Display.publish()` accepting `memory="cuda"` DLPack
tensors) is precisely the consumer such a pipeline needs. The entire gap is the
**handoff from `wgpu` into CUDA**.

### 5.2 Why the handoff is the wall

On Linux, `wgpu-native` does run on **Vulkan** (the question's assumption is correct),
and the Vulkan↔CUDA external-memory mechanism is mature and well documented by NVIDIA:

- `VK_KHR_external_memory` + `VK_KHR_external_memory_fd`: allocate the render target's
  `VkDeviceMemory` as exportable, get an opaque FD.
- `cuImportExternalMemory` / `cuExternalMemoryGetMappedMipmappedArray` (or
  `...GetMappedBuffer`): import that FD as a CUDA array/pointer — **no copy**.
- `VK_KHR_external_semaphore_fd` + `cuImportExternalSemaphore`: share timeline
  semaphores so CUDA waits for the render to finish before NVENC reads the image.

NVIDIA's own Video Codec SDK samples (`AppEncode` with GL/Vulkan interop) do exactly
this to feed `NvEncoderCuda` from a graphics-rendered image — i.e. the technique is
known-good and is *the same `NvEncoderCuda`* this repo already wraps in `pdum.nvenc`.

**The blocker is entirely on the `wgpu` side.** `wgpu-py` is a thin Python wrapper over
the WebGPU API; it deliberately exposes *no* native Vulkan handles and *no*
`create_texture_from_hal` / `create_buffer_from_hal`. Those exist only in the Rust HAL
layer of `wgpu`, which upstream documents as unstable and internal ("expected to be
used less, with breaking changes more often"). The canonical
[CUDA↔wgpu discussion (gfx-rs/wgpu #7988)](https://github.com/gfx-rs/wgpu/discussions/7988)
lays out a ~10-step recipe — restrict the instance to the Vulkan backend, pull the HAL
adapter/device, allocate external Vulkan memory, `create_buffer_from_hal::<Vulkan>()`,
import into CUDA, and *separately* export device fences into CUDA for sync — but every
step is **Rust**, against the unstable HAL, with explicit use-after-free hazards on
teardown. None of it is reachable from `wgpu-py`'s Python surface. The related issues
([wgpu #2320](https://github.com/gfx-rs/wgpu/issues/2320),
[wgpu-native #422](https://github.com/gfx-rs/wgpu-native/issues/422)) confirm there is
**no standard public API** for importing/exporting external textures, and CUDA interop
"is not yet stable."

### 5.3 What zero-copy would actually require here

To make WebGPU→NVENC zero-copy in this project you would need to build a native shim
that:

1. Forces `wgpu` onto the Vulkan backend and reaches its HAL device/queue.
2. Allocates the `pygfx`/`wgpu` render target (or a blit target) as **exportable**
   external Vulkan memory, and exports an FD (memory **and** a timeline semaphore).
3. Imports both into CUDA, exposing the image as something with
   `__cuda_array_interface__` / DLPack so it drops straight into
   `gpu.rgb_to_nv12(...)` and `Display.publish()`.

This is a Rust + CUDA extension of roughly the same character and effort as the
existing `packages/nvenc/` native package (pybind11/scikit-build-core, driver-ABI
care, auditwheel). It is a **research spike**, not API glue. It would also be coupled
to specific `wgpu`/`wgpu-native` versions and their unstable HAL.

### 5.4 The pragmatic shortcut: you may not need WebGPU for zero-copy at all

`pdum.rfb`'s zero-copy story is **already complete for CUDA-native render sources.**
`Display.publish()` accepts a CuPy / DLPack CUDA tensor today and routes it to NVENC
with no host copy. So if the goal is "render on GPU, encode on GPU, never touch host
memory," the supported path is to render with a CUDA-native stack (CuPy compute, a
CUDA/OptiX renderer, a Torch pipeline) whose output is already a CUDA tensor — *not* to
route through `wgpu`. The zero-copy gap is specific to wanting the **WebGPU** render
engine (`pygfx`/`fastplotlib`) as the source.

A second, lower-mature alternative is to run `wgpu` on its **OpenGL** backend and use
the older CUDA-GL interop (`cudaGraphicsGLRegisterImage`) — but that still needs the GL
texture handle, which `wgpu-py` likewise doesn't expose, so it hits the same wall by a
different door (and GL is a secondary `wgpu-native` backend).

## 6. Recommendation

1. **Build the bitmap-path `rendercanvas` backend now.** Low risk, high value, unlocks
   the entire `pygfx`/`fastplotlib` ecosystem over this library's transport. Belongs on
   the roadmap next to the React-hook / anywidget adapters.
2. **For GPU-native users who want true zero-copy today, document the CuPy/DLPack
   `publish()` path** (already supported) as the answer — render with CUDA, not WebGPU.
3. **File zero-copy WebGPU→NVENC as a research spike, explicitly gated on upstream
   `wgpu` external-memory interop** (or a bespoke Rust/CUDA HAL shim). Track
   gfx-rs/wgpu #7988 / #2320. Do not promise it against the public `wgpu-py` API,
   because that API cannot deliver it.

The encouraging framing: the hard, GPU-specific half of the zero-copy pipeline
(NV12 conversion + `NvEncoderCuda` + a `publish()` that takes device memory) is *already
done* in this codebase. If/when `wgpu` exposes external-memory export to Python, wiring
it to NVENC here is a small job.

## 7. Should we adopt the renderview event schema?

**Recommendation: yes — converge `pdum.rfb`'s normalized event vocabulary onto the
[renderview spec](https://github.com/pygfx/renderview/blob/main/src/spec.md), keeping a
couple of strictly-additive extras.** Do it now, pre-1.0, while we own both ends.

> **Status: implemented.** The event layer below now emits the renderview vocabulary
> (logical coords; `button` 0=none/1=left/2=right/3=middle; `buttons` tuple; capitalized
> `modifiers`; `set_viewport` → logical `width`/`height` + physical `pwidth`/`pheight` +
> `ratio`; per-event `timestamp`), keeping `code` on key events as the additive extra.
> The tables below document the migration that was applied.

### Why

The "renderview spec" is the event vocabulary that `jupyter_rfb`, `pygfx`,
`fastplotlib`, and `rendercanvas` all speak — extracted from `jupyter_rfb` into a shared
spec (with a JS reference normalizer, `renderview.js`). It is *exactly* our target
audience's lingua franca. Two payoffs: the rendercanvas backend's `_to_rendercanvas_event`
(§3) shrinks to a **two-key rename** (`type`→`event_type`, `timestamp`→`time_stamp`) since
every *value* already matches — and it collapses to the identity once `rendercanvas` 2.x
finishes migrating to `type`; and `renderview.js` is the upstream version of what
`widgets/src/events.ts` reinvents, so we can track it instead of maintaining our own
normalization semantics.

> Note: as of `rendercanvas` 2.6.3 the shipping API still *consumes* the legacy keys
> (`submit_event` requires `event_type`; it uses `time_stamp`/`pixel_ratio`). The
> renderview spec — and `jupyter_rfb`'s back-compat notes — show `type`/`timestamp`/`ratio`
> as the direction of travel, so our two-key shim is temporary by design.

And we already match its most visible choice: renderview **migrated** `event_type`→`type`
and `pixel_ratio`→`ratio`, so our `type` field is the *current* convention, not the
legacy one. We "made ours up" and there is no external consumer locked to it yet, so the
cost of aligning is at its lowest.

### The actual diffs (small, mechanical)

| Field | `pdum.rfb` today | renderview | Change |
| --- | --- | --- | --- |
| event-type key | `type` | `type` | ✅ already match |
| pointer `button` | DOM (0=left, 1=middle, 2=right) | 0=none, **1=left, 2=right, 3=middle** | remap enum |
| `buttons` | DOM **bitmask** int | **tuple of pressed button ints** | bitmask → tuple |
| `modifiers` | `["shift","ctrl","alt","meta"]` | `("Shift","Control","Alt","Meta")` | capitalize / rename `ctrl`→`Control` |
| `wheel` `dx`/`dy` | px (deltaMode-normalized) + `mode:"pixel"` | px-ish (~100/notch), no `mode` | drop `mode`; units already close |
| key events | `key` **+ `code`** | `key` only | keep `code` (additive, see below) |
| `resize` | `width`,`height`,`pixel_ratio` | `width`,`height` (logical), `pwidth`,`pheight` (physical), `ratio` | add physical dims; `pixel_ratio`→`ratio` |
| per-event time | none (server stamps `received_us`) | `timestamp` (float s) | add client `timestamp` |

The only genuine judgment call is **coordinate units**. renderview sends *logical*
canvas coords + `ratio`; we currently send *framebuffer pixels* (already scaled by the
backing ratio), which suits our model where the publisher owns the render resolution.
Recommendation: match renderview (logical coords + `ratio`) so the schema is drop-in for
`pygfx`, and let the publisher recover framebuffer pixels as `x * ratio` when it wants
them — both are then always reconstructable from one event.

### Deliberate extras to keep

- **`code`** on key events (the physical-key / layout-independent identity, à la DOM
  `KeyboardEvent.code`). renderview only carries `key`; `code` is what shortcut/game-style
  interaction actually needs, and it's purely additive — a renderview consumer ignores it.

### Cost

A bounded change touching three synced surfaces: the browser normalizer
(`widgets/src/events.ts` / `eventTypes.ts`), the server-side event types, and the
committed protocol fixtures (`widgets/tests/fixtures/protocol/`, regenerated via
`python -m pdum.rfb.testing`). Because those fixtures already pin Python↔TS byte
compatibility, the migration is mechanical and self-verifying. It is a **breaking wire
change**, which is precisely why now (pre-1.0, no external consumers) is the time.

---

## Sources

- [How backends work — rendercanvas](https://rendercanvas.readthedocs.io/stable/backendapi.html)
- [Backends (jupyter_rfb vs anywidget, loop integration) — rendercanvas](https://rendercanvas.readthedocs.io/latest/backends.html)
- [renderview event spec](https://github.com/pygfx/renderview/blob/main/src/spec.md) (the `type`/`buttons`/`modifiers`/`ratio` vocabulary shared by jupyter_rfb / pygfx / fastplotlib) and [minimal package design](wgpu_nvenc_zerocopy.md)
- [`rendercanvas/jupyter.py`](https://github.com/pygfx/rendercanvas/blob/main/rendercanvas/jupyter.py) and [`rendercanvas/offscreen.py`](https://github.com/pygfx/rendercanvas/blob/main/rendercanvas/offscreen.py) (the bitmap-present backend templates)
- [wgpu-py guide / API](https://wgpu-py.readthedocs.io/en/stable/guide.html) (bitmap present = render-to-texture then download to RAM)
- [Share buffer between CUDA and wgpu — gfx-rs/wgpu #7988](https://github.com/gfx-rs/wgpu/discussions/7988) (the Rust/HAL 10-step recipe; no public API)
- [Texture memory import API — gfx-rs/wgpu #2320](https://github.com/gfx-rs/wgpu/issues/2320) and [native texture sharing — wgpu-native #422](https://github.com/gfx-rs/wgpu-native/issues/422)
- [CUDA Interoperability with APIs (Vulkan external memory/semaphores)](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/graphics-interop.html) and [CUDA external-resource interop API](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EXTRES__INTEROP.html)
- In-repo: [`gpu_zerocopy.md`](gpu_zerocopy.md), `src/pdum/rfb/gpu.py` (`rgb_to_nv12`), `src/pdum/rfb/display.py` (`publish` accepts CUDA tensors), `packages/nvenc/` (`NvEncoderCuda`)
