# A minimal package for zero-copy wgpu-native → NVENC

Follow-on to [`rendercanvas_backend.md`](rendercanvas_backend.md) §5. We *do* want the
`wgpu` ecosystem (`pygfx`/`fastplotlib`). This doc scopes the smallest package that
makes a `wgpu`-rendered frame reach NVENC **without a host round-trip** on Linux
(`wgpu-native` → Vulkan), and lays out a de-risking spike.

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
[`rendercanvas_backend.md`](rendercanvas_backend.md) §4 — nothing breaks silently.

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
  external-memory API, the patch shrinks or disappears.
- **Synchronization correctness** is the classic footgun (encoding a torn frame). The
  timeline-semaphore wait is non-negotiable; budget test time here.
- **Row pitch / format.** WebGPU `bytesPerRow` 256-alignment and RGBA vs BGRA ordering
  must match the kernel. Small, but get it right in the spike.
- **Single-GPU / single-context.** The Vulkan device and the CUDA context must be the
  same physical GPU; reuse `enable_cuda_context_sharing`'s primary-context discipline.
- **Teardown.** External memory/semaphore lifetimes cross two runtimes — free in the
  right order (CUDA imports first, then wgpu resources) to avoid use-after-free, the
  hazard called out explicitly in wgpu #7988.

## Effort

| Phase | Effort |
| --- | --- |
| Spike (steps 1–3 above) | ~1–2 days |
| `wgpu-native` patch (extension tweak + 3 C functions, build/CI, wheel) | ~1–2 weeks |
| `pdum.wgpu` glue (`cuda-python` import + sync + reuse encode tail) | ~3–5 days |
| Integration w/ the rendercanvas backend + benchmark + e2e | ~1 week |

Bounded and incremental — and the spike tells you within two days whether the whole
thing flies before any package work.

## Recommendation

Run the spike. It is cheap and it converts the central unknown ("can we even get a
CUDA-importable handle out of wgpu?") into a yes/no with a checksum. If green, build the
patched-`wgpu-native` + `pdum.wgpu` package; the encode half is already done here. Keep
the patch minimal and track the upstream interop issues so we can drop it when wgpu
exposes external memory natively.

---

## Sources

- [wgpu-py — custom native lib via `WGPU_LIB_PATH`](https://wgpu-py.readthedocs.io/en/stable/start.html) and [backends / `set_instance_extras`](https://wgpu-py.readthedocs.io/en/stable/backends.html)
- [Interop with underlying graphics API — gfx-rs/wgpu #965](https://github.com/gfx-rs/wgpu/issues/965) (C API exposes no native handles — still open)
- [Enable arbitrary Vulkan extensions — gfx-rs/wgpu #7324](https://github.com/gfx-rs/wgpu/issues/7324) and [Share buffer between CUDA and wgpu — #7988](https://github.com/gfx-rs/wgpu/discussions/7988)
- [`wgpu-hal` Vulkan: `as_hal`, `Buffer::raw_handle()`, `Adapter::open_with_callback`](https://docs.rs/wgpu-hal/) (the Rust-only pieces the patch surfaces to C)
- [CUDA external-resource interop (`cuImportExternalMemory`, `cuImportExternalSemaphore`, `cuWaitExternalSemaphoresAsync`)](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EXTRES__INTEROP.html) and [Vulkan interop guide](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/graphics-interop.html)
- Prior art: [`ustreamer-capture`](https://docs.rs/ustreamer-capture/) (zero-copy Vulkan/CUDA external-memory export for NVIDIA, Rust)
- In-repo: `src/pdum/rfb/gpu.py` (`rgb_to_nv12`, `enable_cuda_context_sharing`), `packages/nvenc/` (`NvEncoderCuda`), `src/pdum/rfb/display.py` (`publish` accepts CUDA tensors)
