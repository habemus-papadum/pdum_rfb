# A minimal package for zero-copy wgpu-native → hardware encode (NVENC & VideoToolbox)

Follow-on to [`rendercanvas_backend.md`](../completed/rendercanvas_backend.md) §5. We *do* want the
`wgpu` ecosystem (`pygfx`/`fastplotlib`). This doc scopes the smallest package that
makes a `wgpu`-rendered frame reach a **hardware video encoder without a host
round-trip** — on Linux (`wgpu-native` → Vulkan → CUDA → **NVENC**) and, by the same
design, on macOS (`wgpu-native` → Metal → IOSurface → **VideoToolbox**; see
[The macOS analog](#the-macos-analog-metal-iosurface-videotoolbox)). It lays out a
de-risking spike and how the native piece folds back
[upstream](#upstreaming-vs-shipping-our-own-binary).

## Verdict up front

- **Three of the four pipeline stages already exist in this repo** — the RGBA→NV12
  CUDA kernel (`gpu.rgb_to_nv12`), the PyAV-free CUDA encoder (`pdum.nvenc`'s
  `NvEncoderCuda`), and a `publish()` that already accepts `memory="cuda"` DLPack
  tensors. The only missing stage is **getting a CUDA-importable handle out of wgpu**.
- That handle **cannot** be obtained through any public API. `wgpu-py` is CFFI over
  `wgpu-native`'s **C** API, and the C API exposes **no** Vulkan handles and **no**
  external-memory allocation (gfx-rs/wgpu #965 is still open). The HAL pieces that
  *would* do it (`Texture::as_hal`, `vulkan::Buffer::raw_handle()`,
  `Adapter::open_with_callback`) live only in the **Rust** `wgpu-hal` crate.
- **But** `wgpu-py` can be pointed at a **custom `wgpu-native` build** via the
  `WGPU_LIB_PATH` environment variable. That is the linchpin: ship a `wgpu-native`
  with a small **additive** patch (one device-creation tweak + 3 C functions), point
  `wgpu-py` at it, and do the CUDA import in pure Python with `cuda-python`. **No fork of
  `wgpu-py`, no fork of `pygfx`** (see [How the library swap works](#how-the-library-swap-works)).
- **Scope:** a bounded native project, comparable to the existing `packages/nvenc/`,
  plus ~150 lines of Python glue. A spike that *proves the bytes round-trip* (render →
  shared buffer → CUDA → checksum) is ~1–2 days and de-risks everything else.
- **macOS falls out of the same design, and is *simpler*** — `IOSurface` is the native
  shared buffer (no extension dance) and VideoToolbox does the color conversion — but the
  **payoff is smaller** (unified memory: no PCIe to eliminate). See
  [The macOS analog](#the-macos-analog-metal-iosurface-videotoolbox).
- **The native patch is a bridge, not a destination.** The real fix is upstream: a `wgpu`
  API that exports the platform handle (Vulkan FD / Metal IOSurface). Needing *both*
  backends makes that a stronger, more general upstream ask — see
  [Upstreaming vs. shipping our own binary](#upstreaming-vs-shipping-our-own-binary).

## The pipeline, and what's already done

```
pygfx/wgpu render ─► RGBA texture (GPU, Vulkan)
   │  copyTextureToBuffer (GPU→GPU, on-device)
   ▼
shared buffer  ════════════════════════════════  ← THE GAP: must be exportable
   │  Vulkan external-memory FD  →  CUDA import      external memory + a CUDA handle
   ▼
CUDA device ptr (RGBA)  ──►  rgb_to_nv12  ──►  NvEncoderCuda  ──►  Annex B  ──►  publish()
   ✅ cuda-python import      ✅ gpu.py        ✅ pdum.nvenc      ✅ existing   ✅ display.py
```

The encode tail (everything right of "CUDA device ptr") is built and tested today. The
work is the two boxes on the left.

## The one hard constraint that shapes the design

**You cannot export memory that wasn't allocated as exportable.** Vulkan requires
`VkExportMemoryAllocateInfo` at *allocation* time (and the device must have been opened
with `VK_KHR_external_memory_fd` / `VK_KHR_external_semaphore_fd` enabled). A texture or
buffer `wgpu` allocates normally — through its internal gpu-allocator — has none of
that, so there is nothing to hand CUDA. Therefore the shared resource must be created
**through a patched allocation path**, and the device must be opened with the external
extensions. Both are exactly what `wgpu-hal`'s `Adapter::open_with_callback` (extension
injection) and a `create_buffer_from_hal` / custom-allocation entry point provide — in
Rust, which is why the patch lives in `wgpu-native`.

## Recommended architecture: patched `wgpu-native` + pure-Python glue

Two artifacts:

### 1. `wgpu-native` patch (the only native code)

A small FFI module added to `wgpu-native` (Rust), built and shipped as a wheel that
bundles the patched `libwgpu_native.so`; consumers set `WGPU_LIB_PATH` to it. It does
two things, both deliberately minimal:

**(a) One behaviour tweak to the existing device-creation path.** When `wgpu-native`
opens the Vulkan device, also enable `VK_KHR_external_memory_fd` /
`VK_KHR_external_semaphore_fd` *when the GPU supports them*. This is the only change to
existing behaviour and it is backward-compatible (it just enables extra capabilities).
The payoff: **`pygfx`/`wgpu-py` create the device 100% normally** and it already has what
we need — no separate `requestDeviceExportable`, no foreign-device adoption.

**(b) Three *additive* C functions** (the only new symbols; existing ones are untouched,
so `wgpu-py`'s cdefs still match byte-for-byte):

| New C function | Does |
| --- | --- |
| `pdum_create_exportable_target(dev, w, h, &mem_fd, &sem_fd) -> Target*` | Allocate a `VkBuffer` + `VkDeviceMemory` (`VkExportMemoryAllocateInfo`) + an exportable timeline semaphore; return opaque-FDs for both and an opaque handle we keep. |
| `pdum_copy_texture_to_target(queue, srcTexture, Target*, signalValue)` | Record `copyTextureToBuffer(srcTexture → our buffer)`, submit on the queue, signal the semaphore. |
| `pdum_destroy_target(Target*)` | Free the Vulkan buffer / memory / semaphore. |

The crucial design choice: **the exportable buffer never becomes a `wgpu-py` object.** It
lives entirely inside `Target` on the native side, so `wgpu-py` is never asked to *adopt*
a foreign buffer (the thing it can't do cleanly). Python holds only the two FDs and passes
in the *source texture's* raw handle. Internals use `device.as_hal::<Vulkan>(…)` to reach
the `ash::Device`, allocate the exportable buffer, and `create_buffer_from_hal` to record
the copy.

> Why a buffer, not a texture: `copyTextureToBuffer` targets a **linear** buffer, so
> CUDA sees a plain device pointer (no Vulkan image tiling/layout to reason about) and
> `rgb_to_nv12` consumes it directly. The only wrinkle is WebGPU's 256-byte
> `bytesPerRow` alignment — the CUDA side reads with that row pitch (a one-line change
> to the NV12 kernel's row stride, or a tight-packing copy).

### 2. `pdum.wgpu` (pure Python, sibling of `pdum.nvenc`)

No compiled code — just `ctypes` + `cuda-python`. Given a normally-created `wgpu-py`
device, queue, and render texture:

1. `ctypes.CDLL(WGPU_LIB_PATH)` — the **same** file `wgpu-py` already loaded, so the new
   symbols resolve into the same in-memory library and the same `wgpu-native` object
   registry. Pass `device._internal` / `texture._internal` (the raw native handles
   `wgpu-py` exposes, as integer pointers) straight into the new functions. No `wgpu-py`
   fork, no foreign-object wrapping.
2. `cuda-python`: `cuImportExternalMemory(mem_fd)` → `cuExternalMemoryGetMappedBuffer` →
   a device pointer; wrap it as a `__cuda_array_interface__` object (so it drops straight
   into `gpu.rgb_to_nv12` / `cuda_frame`). Done once, in the constructor.
3. Per frame: `pdum_copy_texture_to_target(...)` then `cuWaitExternalSemaphoresAsync`
   before the encode, so NVENC never reads a half-rendered buffer.
4. Hand the CUDA RGBA pointer to `gpu.rgb_to_nv12(...)` → `pdum.nvenc` → `publish()`.

### Per-frame flow (steady state, all on-GPU)

```
pygfx draw ─► pdum_copy_texture_to_target(queue, rgba_tex, target, N)   # copy + submit + signal
CUDA: cuWaitExternalSemaphore ≥ N ─► rgb_to_nv12(target buf) ─► NvEncoderCuda.encode() ─► publish()
```

No `map_read`, no PCIe transfer, no host buffer. The copy is a GPU-local
texture→buffer; everything downstream is CUDA on the same device.

## How the library swap works

The swap is one environment variable, read once at `import wgpu`:

```bash
WGPU_LIB_PATH=/opt/pdum-wgpu/libwgpu_native.so  python app.py
```

`wgpu-py` is CFFI over `wgpu-native`; at import it `dlopen`s a `libwgpu_native.so`,
checking `WGPU_LIB_PATH` first. Point it at the patched build and `pygfx` / `fastplotlib`
/ `wgpu-py` all run on it. There is no other mechanism — no monkeypatch, no symbol
interposition. Three properties keep it honest:

- **The patch is purely additive.** New exported symbols only; no existing signature or
  struct layout changes. So `wgpu-py`'s generated cdefs still match byte-for-byte — it
  neither knows nor needs to know the extra symbols exist.
- **One library, loaded once.** When `pdum.wgpu` calls the new functions it `ctypes.CDLL`s
  the **same file** (`WGPU_LIB_PATH`). On Linux, `dlopen` of the same path returns the
  same in-memory image, so the ctypes handle and `wgpu-py`'s CFFI handle share the one
  `wgpu-native` instance and its object registry. That is why a `WGPUDevice` / `WGPUTexture`
  created by `wgpu-py` is valid to pass straight into a patched function.
- **ABI pinned to `wgpu-py`'s exact `wgpu-native` version.** The one hard rule and the
  main maintenance cost. `wgpu-py` records the version it was built against (in its
  package `resources/wgpu_native-version`); the patch must be applied to *that* tag. A
  mismatched version drifts the ABI and crashes. Every `wgpu-py` bump → rebase the patch.

### Least-magic scorecard

| Concern | How it's handled |
| --- | --- |
| Which native lib loads | Explicit `WGPU_LIB_PATH` you set; inspectable |
| Patching Python / `wgpu-py` | None — additive C symbols called via our own `ctypes` handle |
| Two wgpu instances? | No — same `.so`, one `dlopen`, shared registry |
| Foreign-object adoption | None — exportable buffer stays native; Python passes only FDs + `._internal` handles |
| Device creation | Normal `wgpu-py`/`pygfx`; the patch just enables extra extensions under the hood |
| Is the patched lib active? | Explicit `assert_patched()` probe; clear error + bitmap fallback if not |

**Unavoidable magic:** replacing the `.so` (the C-API gap forces it) and pinning it to
`wgpu-py`'s version. Everything else is explicit.

## What this reuses vs. adds

| Piece | Status |
| --- | --- |
| RGBA(row-pitched)→NV12 CUDA kernel | ✅ `gpu.rgb_to_nv12` (add row-stride arg) |
| NV12 → Annex B, no PyAV | ✅ `pdum.nvenc` `NvEncoderCuda` |
| `publish()` accepts CUDA/DLPack | ✅ `display.py` |
| Shared CUDA context (CuPy ↔ encoder) | ✅ `gpu.enable_cuda_context_sharing` |
| External-memory **export** from wgpu | ❌ `wgpu-native` patch (artifact 1) |
| FD → CUDA import + semaphore sync | ❌ `pdum.wgpu`, via `cuda-python` (artifact 2) |
| New runtime dep | `cuda-python` (driver-API external-memory/semaphore calls) |

## Developer build & install flow

```bash
# 1. Pin wgpu-py and discover the exact wgpu-native version it expects.
pip install wgpu==<X.Y.Z>
WGPU_NATIVE_TAG=$(python -c "import wgpu, pathlib; \
  print((pathlib.Path(wgpu.__file__).parent/'resources'/'wgpu_native-version').read_text().strip())")

# 2. Build the patched native lib (needs a Rust toolchain).
git clone https://github.com/gfx-rs/wgpu-native && cd wgpu-native
git checkout "$WGPU_NATIVE_TAG"
git apply /path/to/pdum-wgpu.patch        # additive FFI module + the device-extension tweak
cargo build --release                     # -> target/release/libwgpu_native.so

# 3. Install the pure-Python glue + CUDA bindings.
pip install pdum-wgpu cuda-python
```

Two delivery options:

- **Least magic (baseline):** the developer sets `WGPU_LIB_PATH` to the built `.so`
  themselves — they can see exactly which file loads.
- **Convenience wheel (optional):** a `pdum-wgpu-native` wheel bundles the prebuilt,
  `auditwheel`'d `.so` (the `packages/nvenc/` pattern), and `python -m pdum.wgpu
  --print-lib-path` prints the path to export. Still explicit — nothing sets the env var
  behind your back.

## Python API: enabling zero-copy

```python
import os
# THE one ordering rule — set this BEFORE `import wgpu` (like enable_cuda_context_sharing).
os.environ["WGPU_LIB_PATH"] = "/opt/pdum-wgpu/libwgpu_native.so"

import wgpu, pygfx
import pdum.rfb as rfb
from pdum.wgpu import ExportableTarget, assert_patched

assert_patched()              # explicit probe; raises if WGPU_LIB_PATH isn't the patched build

display = await rfb.serve(1280, 720, port=8765, gpu=True)

# 100% normal pygfx — device / renderer / texture made the usual way:
device = wgpu.utils.get_default_device()
texture = device.create_texture(
    size=(1280, 720, 1), format="rgba8unorm",
    usage=wgpu.TextureUsage.RENDER_ATTACHMENT | wgpu.TextureUsage.COPY_SRC)
renderer = pygfx.renderers.WgpuRenderer(texture)

target = ExportableTarget(device, texture, 1280, 720)   # opt in to zero-copy here

while running:
    renderer.render(scene, camera)
    rgba = target.capture()                       # GPU-local copy + semaphore wait
    display.publish(rfb.gpu.cuda_frame(rgba))     # -> rgb_to_nv12 -> NVENC, no host copy
```

The entire user-facing surface is three things: **set one env var (before `import wgpu`),
call `assert_patched()`, wrap your render texture in `ExportableTarget`.** Everything else
is ordinary `pygfx`. If `WGPU_LIB_PATH` isn't the patched build, `assert_patched()` raises
with a clear message and you fall back to the bitmap (host-download) path from
[`rendercanvas_backend.md`](../completed/rendercanvas_backend.md) §4 — nothing breaks silently.

`ExportableTarget` does the one-time CUDA import of the two FDs (memory + semaphore) in its
constructor; `capture()` calls `pdum_copy_texture_to_target` then
`cuWaitExternalSemaphoresAsync` and returns a zero-copy `__cuda_array_interface__` RGBA
view. `_raw(obj)` — the only "reach into `wgpu-py`" — is just
`int(ffi.cast("intptr_t", obj._internal))`.

## How hard is the patch to build?

Bounded, **known-good** systems work (NVIDIA's own Vulkan→NVENC samples do this exact
external-memory dance) — not research. The cost is the domain, not the line count
(~300–500 lines of Rust):

| Part | Difficulty |
| --- | --- |
| Build *stock* `wgpu-native` (`cargo build`) | Easy — an afternoon incl. toolchain |
| De-risking spike (exportable buffer + CUDA import + checksum; no semaphore/NVENC) | ~1–2 days — proves the premise |
| Full patch (extension tweak + 3 fns + `create_buffer_from_hal` + semaphore) | ~1–2 weeks for someone fluent in Rust + Vulkan/`ash` |
| Keeping it alive across `wgpu-py` bumps | Ongoing rebase; the `as_hal` API has changed shape across releases |

What makes it non-trivial: it's `unsafe` Rust against `wgpu-hal`'s **unstable internal**
API plus `ash` (raw Vulkan); `create_buffer_from_hal` needs the usage/format flags exactly
right; and the timeline-semaphore sync is the classic torn-frame footgun (see *Risks &
unknowns* below). None of it is novel — it's careful, version-specific plumbing. See the
*Effort* table below for whole-package phase estimates.

## Alternative architecture (heavier, noted for completeness)

**Rust owns the device.** A single `pyo3` extension creates the `wgpu` instance/
adapter/device (Vulkan + external mem), allocates the shared image, runs NVENC, and
exposes the device to `wgpu-py` so `pygfx` renders on it. Cleaner at runtime (one
artifact, no `WGPU_LIB_PATH` dance) but it requires `wgpu-py` to **adopt a
foreign-created device**, which it doesn't support cleanly today — so it pulls in a
`wgpu-py` change and couples to its internals. The patched-`wgpu-native` route keeps the
device firmly inside `wgpu-py` and is the smaller bet. Revisit this only if maintaining
a `wgpu-native` patch against fast-moving releases proves worse than owning the device.

## The macOS analog: Metal, IOSurface, VideoToolbox

The same gap exists on macOS — `wgpu-native` renders on **Metal** and its C API exposes no
`MTLTexture` / `IOSurface` handle — but the analog is **structurally identical and simpler**,
because macOS already ships the cross-API shared-buffer primitive the Vulkan side has to
construct by hand: **`IOSurface`**.

```
pygfx/wgpu render ─► RGBA MTLTexture (GPU, Metal)
   │  blit into an IOSurface-backed target (GPU→GPU, on-device)
   ▼
IOSurface  ═══════════════  ← the shared buffer: a system object, no export dance
   │  CVPixelBufferCreateWithIOSurface  (wrap, no copy)
   ▼
CVPixelBuffer ─► VideoToolbox (pdum.vtenc) ─► Annex B ─► publish()
```

Three things make the Metal path **easier** than the CUDA one, not just different:

1. **No device-creation tweak.** Vulkan must enable `VK_KHR_external_memory_fd` *at device
   creation* (patch part (a)). Any `MTLDevice` can already make an IOSurface-backed texture
   (`newTextureWithDescriptor:iosurface:plane:`), so the Metal patch is **purely** the
   additive functions — zero change to existing behaviour.
2. **VideoToolbox does the color conversion.** NVENC eats only NV12 — that's *why* the CUDA
   path must run `rgb_to_nv12` first. A `VTCompressionSession` accepts a source
   `CVPixelBuffer` and converts internally, so the RGB→NV12 stage can drop out. Two surface
   choices: a **BGRA** IOSurface (VT converts; least `wgpu` work — a plain blit) or an
   **NV12-biplanar** IOSurface (convert in a `wgpu` compute pass or MLX; matches `vtenc`'s
   existing `420v` session unchanged).
3. **No context / GPU matching.** CUDA needs the Vulkan device and the CUDA context on the
   same physical GPU (`enable_cuda_context_sharing`). `IOSurface` is a device-agnostic system
   object; VideoToolbox reads it regardless of which `MTLDevice` wrote it. One fewer invariant.

`wgpu-hal`'s Metal backend reaches the raw objects exactly as the Vulkan one does —
`Texture::as_hal::<Metal>` → `&metal::TextureRef`, `Device::as_hal::<Metal>` → the
`MTLDevice`, `Queue::as_hal::<Metal>` → the command queue — and the `WGPU_LIB_PATH` swap plus
the "same `.so`, one `dlopen`, shared registry" argument hold identically on macOS.

**The macOS patch** (analog of the three C functions):

| New C function | Does |
| --- | --- |
| `pdum_metal_create_exportable_target(dev, w, h) -> {Target*, IOSurfaceRef}` | Create an `IOSurface` (BGRA or NV12) + an IOSurface-backed `MTLTexture` via `as_hal`; return the surface handle + an `MTLSharedEvent`. |
| `pdum_metal_blit_to_target(queue, srcTex, Target*, event, value)` | Blit `srcTex → target` on a command buffer, `encodeSignalEvent(event, value)`, commit. |
| `pdum_metal_destroy_target(Target*)` | Release the texture / surface / event. |

**What this reuses vs. adds (macOS):**

| Piece | Status |
| --- | --- |
| BGRA/NV12 → Annex B via VideoToolbox | ✅ `pdum.vtenc` — its `CVPixelBuffer`s are *already* `420v`, IOSurface-backed |
| RGB→NV12 on the GPU (optional here) | ✅ `metal.rgb_to_nv12` (MLX) — **skippable** if VideoToolbox converts BGRA |
| `publish()` accepts a Metal frame | ✅ `display.py` / `metal.metal_frame` |
| IOSurface-backed **target** from wgpu | ❌ `wgpu-native` Metal patch (analog artifact 1) |
| IOSurface → `CVPixelBuffer` submit path | ❌ small `pdum.vtenc` addition: `encode_iosurface(handle)` (wrap via `CVPixelBufferCreateWithIOSurface`, submit) — bypasses today's host-NV12 memcpy fill |
| Sync (`MTLSharedEvent` / command-buffer completion) | ❌ `pdum.wgpu`: host waits the blit before submitting to VideoToolbox |

The one net-new encoder piece — `encode_iosurface` — is small: `vtenc` already *owns*
IOSurface-backed `CVPixelBuffer`s and memcpies host NV12 into them (`vtenc_ext.mm` calls that
memcpy "the cost a zero-copy path [eliminates]"); the zero-copy entry just wraps a
*caller-provided* surface instead. It is the exact analog of `NvEncoderCuda`'s GPU-pointer path.

**The honest catch — the payoff is smaller on macOS.** On CUDA the win is removing a **PCIe
host round-trip** (the measured 2.4–4.3×). Apple Silicon has **unified memory**: there is no
bus transfer to eliminate. The only copy the zero-copy path removes is host-NV12 →
`CVPixelBuffer`, which `metal.py` itself already calls *"negligible."* So Metal zero-copy is a
**plumbing win** — one fewer copy, and RGB→YUV moved off the CPU onto the encoder — not a
latency breakthrough. **Prioritize accordingly: ship the Linux/CUDA path first for the real
gain; treat the Metal analog as the cheaper, lower-risk follow-on.** It rides the whole design
and — crucially — turns the upstream ask into a general, two-backend "export the native handle"
feature (below), a stronger contribution than either backend alone.

## The de-risking spike (do this first — ~1–2 days)

Prove the **handle round-trips correct bytes**; ignore NVENC entirely at first.

1. Confirm `wgpu-py` runs `pygfx` against a locally built stock `wgpu-native` via
   `WGPU_LIB_PATH` (no patch yet). *Pure config; flushes out the build/version match.*
2. Add the device-extension tweak + a minimal `pdum_create_exportable_target` (memory
   FD only — skip the semaphore for now). Rebuild.
3. From Python: render a known test pattern, `copyTextureToBuffer` into the shared
   buffer, `cuImportExternalMemory(fd)`, `cuMemcpyDtoH`, and assert the bytes equal the
   rendered frame (or compare against a `map_read` of a normal copy). **Green here =
   the entire zero-copy premise is proven.**
4. Add the timeline semaphore; confirm correctness under a tight render/encode loop.
5. Only then wire `rgb_to_nv12` → `pdum.nvenc` → `publish()` (all already tested) and
   benchmark against the bitmap (host-download) path from `rendercanvas_backend.md` §4.

## Risks & unknowns

- **Version pinning.** The patch tracks a specific `wgpu-native` (hence `wgpu-py`)
  release; each bump is a rebase. Mitigate by keeping the patch tiny (FFI shim only) and
  pinning `wgpu` in the workspace. Watch upstream: gfx-rs/wgpu **#965** (interop),
  **#7324** (arbitrary Vulkan extensions), **#7988** (CUDA↔wgpu) — if any land a public
  external-memory API, the patch shrinks or disappears. See
  [Upstreaming vs. shipping our own binary](#upstreaming-vs-shipping-our-own-binary).
- **Synchronization correctness** is the classic footgun (encoding a torn frame). The
  timeline-semaphore wait is non-negotiable; budget test time here.
- **Row pitch / format.** WebGPU `bytesPerRow` 256-alignment and RGBA vs BGRA ordering
  must match the kernel. Small, but get it right in the spike.
- **Single-GPU / single-context.** The Vulkan device and the CUDA context must be the
  same physical GPU; reuse `enable_cuda_context_sharing`'s primary-context discipline.
- **Teardown.** External memory/semaphore lifetimes cross two runtimes — free in the
  right order (CUDA imports first, then wgpu resources) to avoid use-after-free, the
  hazard called out explicitly in wgpu #7988.
- **macOS sync + source format.** The blit must finish before VideoToolbox reads the
  `IOSurface` — host-wait the command buffer or an `MTLSharedEvent`. A **BGRA** surface needs
  the `VTCompressionSession` to accept a BGRA source; an **NV12** surface keeps `vtenc`'s
  existing `420v` session unchanged at the cost of a conversion pass.

## Effort

| Phase | Effort |
| --- | --- |
| Spike (steps 1–3 above) | ~1–2 days |
| `wgpu-native` patch (extension tweak + 3 C functions, build/CI, wheel) | ~1–2 weeks |
| `pdum.wgpu` glue (`cuda-python` import + sync + reuse encode tail) | ~3–5 days |
| Integration w/ the rendercanvas backend + benchmark + e2e | ~1 week |
| macOS analog (Metal IOSurface patch + `encode_iosurface` + `pdum.wgpu` Metal) | ~1 week, after the Linux path — shares the design, no device tweak |

Bounded and incremental — and the spike tells you within two days whether the whole
thing flies before any package work.

## Upstreaming vs. shipping our own binary

Two ways to live with the C-API gap long-term. They are not exclusive — the right play is to
**pursue the first and ship the second as a bridge.**

**A. Upstream a handle-export API to `wgpu` (the north star).** What has to land is small in
code and large in consensus: a way to (1) allocate a resource with a *dedicated, exportable*
backing, and (2) read back its **platform handle** — a Vulkan external-memory **FD**, a Metal
**`IOSurface`** (or `MTLSharedTextureHandle`), a D3D12 shared handle. This is exactly the
cluster that has sat open for years — gfx-rs/wgpu **#965** (interop), **#7324** (extensions),
**#7988** (CUDA↔wgpu). The reason it's slow is *not* line count: exported handles are inherently
`unsafe`/raw, wgpu's allocator sub-allocates (so you must *force* a dedicated allocation), and
the semantics have to be defined uniformly across backends and squared with the WebGPU spec's
wariness of escape hatches. So "just open up a few features" is right about the **code** and
optimistic about the **merge** — the gate is maintainer API-design review, not difficulty.

The payoff if it lands is total: **the native artifact disappears.** No `WGPU_LIB_PATH`, no ABI
pin, no rebase-per-`wgpu-py`-bump, no bundled `.so` — `pdum.wgpu` becomes pure Python against a
*public, versioned* API on both backends. That is worth real investment even at a months-long
horizon.

*How to make A likely to land, and cheap if it doesn't:* build the local patch
([Recommended architecture](#recommended-architecture-patched-wgpu-native-pure-python-glue))
to **look like the API we'd want upstream** — an `as_hal`-style `create_exportable_texture` +
`export_handle`, not a bespoke `pdum_*` shim — and open a design thread on the existing issues
*before* writing much, so we build toward something maintainers would accept. Our patch then
*is* the reference implementation attached to the PR. Because we now need **both** a Vulkan FD
and a Metal `IOSurface`, the natural proposal is the general per-backend "export the native
handle" feature the issues are already circling — a more compelling ask than a Vulkan-only one,
and it drags Windows/D3D12 along for free.

**B. Ship our own `wgpu-native` binary (the bridge, not the destination).** The "convenience
wheel" from *Developer build & install flow*: a `pdum-wgpu-native` wheel bundling the prebuilt,
`auditwheel`/`delocate`'d `.so`, uv-locked, no `LD_LIBRARY_PATH` fuss — the `packages/nvenc/`
pattern. It works and it's reproducible, but the maintenance is the honest cost: the bundled
`.so` is **ABI-pinned to one exact `wgpu-py`**, so every `wgpu-py` release forces a rebuild +
rebase + republish across (Python versions × platforms), and a user who bumps `wgpu-py` on
their own gets an ABI mismatch. That's the `nvenc` maintenance model, but tracking a
**fast-moving third-party release train** instead of a stable NVIDIA SDK — genuinely heavier,
and a poor thing to sign up for *permanently*. So B earns its keep only as a **temporary
convenience while A is in flight**, explicitly time-boxed to "until upstream exposes handles" —
never a product line we commit to.

**Net:** invest in A (engage the issues; shape the patch as the upstream prototype); use the
developer-built patched `.so`, or optionally the B wheel, as the bridge that ships value now;
delete all of it when the API lands. This promotes the existing *"drop it when wgpu exposes
external memory natively"* note from an aside to the actual plan.

## Recommendation

Run the spike. It is cheap and it converts the central unknown ("can we even get a
CUDA-importable handle out of wgpu?") into a yes/no with a checksum. If green, build the
patched-`wgpu-native` + `pdum.wgpu` package **for CUDA first** (the real, PCIe-sized win); the
encode half is already done here. The **macOS/Metal analog** rides the same design and is
simpler — schedule it as a lower-priority follow-on, since unified memory makes its payoff a
plumbing cleanup rather than a latency jump. Throughout, keep the patch minimal and **shaped
like the upstream API we want**, and engage gfx-rs/wgpu #965 / #7324 / #7988 early — so the
native artifact is a bridge we can [delete](#upstreaming-vs-shipping-our-own-binary) when wgpu
exposes external memory natively, not a fork we're stuck maintaining.

---

## Sources

- [wgpu-py — custom native lib via `WGPU_LIB_PATH`](https://wgpu-py.readthedocs.io/en/stable/start.html) and [backends / `set_instance_extras`](https://wgpu-py.readthedocs.io/en/stable/backends.html)
- [Interop with underlying graphics API — gfx-rs/wgpu #965](https://github.com/gfx-rs/wgpu/issues/965) (C API exposes no native handles — still open)
- [Enable arbitrary Vulkan extensions — gfx-rs/wgpu #7324](https://github.com/gfx-rs/wgpu/issues/7324) and [Share buffer between CUDA and wgpu — #7988](https://github.com/gfx-rs/wgpu/discussions/7988)
- [`wgpu-hal` Vulkan: `as_hal`, `Buffer::raw_handle()`, `Adapter::open_with_callback`](https://docs.rs/wgpu-hal/) (the Rust-only pieces the patch surfaces to C)
- [CUDA external-resource interop (`cuImportExternalMemory`, `cuImportExternalSemaphore`, `cuWaitExternalSemaphoresAsync`)](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EXTRES__INTEROP.html) and [Vulkan interop guide](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/graphics-interop.html)
- Prior art: [`ustreamer-capture`](https://docs.rs/ustreamer-capture/) (zero-copy Vulkan/CUDA external-memory export for NVIDIA, Rust)
- macOS interop: [`IOSurface`](https://developer.apple.com/documentation/iosurface), [`CVPixelBufferCreateWithIOSurface`](https://developer.apple.com/documentation/corevideo/1456715-cvpixelbuffercreatewithiosurface), Metal [`newTextureWithDescriptor:iosurface:plane:`](https://developer.apple.com/documentation/metal/mtldevice/1433378-newtexturewithdescriptor) and [`MTLSharedEvent`](https://developer.apple.com/documentation/metal/mtlsharedevent); [`wgpu-hal` Metal `as_hal`](https://docs.rs/wgpu-hal/)
- In-repo: `src/pdum/rfb/gpu.py` (`rgb_to_nv12`, `enable_cuda_context_sharing`), `src/pdum/rfb/metal.py` (Metal `rgb_to_nv12`, `metal_frame`), `packages/nvenc/` (`NvEncoderCuda`), `packages/vtenc/` (`VtEncoder`, IOSurface-backed `CVPixelBuffer`s), `src/pdum/rfb/display.py` (`publish` accepts CUDA/Metal frames)
