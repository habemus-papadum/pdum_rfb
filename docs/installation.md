# Installation

`pdum.rfb` works out of the box with a dependency-light **image** path and grows
into hardware H.264 via extras. This page lists every option, **easiest + fastest
first**, and the platform limits that apply to the GPU paths.

> **Not sure what your box supports?** Install the CLI and ask:
>
> ```bash
> pip install 'habemus-papadum-rfb[cli]'
> pdum-rfb doctor
> ```
>
> `doctor` probes every encode path and tells you which one to prefer (see
> [Performance](performance.md) for why).

## TL;DR — pick a path

| Want | Install | Works on | Speed |
| ---- | ------- | -------- | ----- |
| Just stream something | `pip install habemus-papadum-rfb` | anywhere | image only |
| Software H.264 | `pip install 'habemus-papadum-rfb[h264]'` | anywhere PyAV has wheels | good |
| **GPU H.264 (recommended)** | `pip install 'habemus-papadum-rfb[gpu-nvenc-sdk]'` | Linux · amd64 · NVIDIA | **fastest** |
| GPU H.264 (PyAV route) | `[gpu-cuda13]` + **PyAV 18** | Linux · NVIDIA | fastest |

The two GPU rows reach the same hardware NVENC speed; the **SDK path is easier to
install** — one `pip install` of a prebuilt wheel (`habemus-papadum-nvenc`) straight
from PyPI, no PyAV-18 build — and is what `doctor` recommends when present. Details below.

## 1. Core — the image path (no extras)

```bash
pip install habemus-papadum-rfb       # or: uv add habemus-papadum-rfb
```

Pulls only `numpy`, `pillow`, `websockets`. Every frame is an independent
JPEG/PNG/WebP. Runs anywhere Python 3.14 runs — no GPU, no compiler, no system
libraries. Good for stills, snapshots, and the lossless-final still.

## 2. CPU H.264 — `[h264]`

```bash
pip install 'habemus-papadum-rfb[h264]'
```

Adds PyAV (libx264). Software H.264 — far smaller than image-per-frame at the same
quality, and it installs anywhere PyAV publishes wheels. No GPU required. This is
the best **portable** video path.

## 2b. Mount in an ASGI app — `[asgi]`

```bash
pip install 'habemus-papadum-rfb[asgi]'
```

Adds Starlette so you can host the framebuffer **inside** an existing
Starlette/FastAPI app (same origin, sharing its TLS and session cookie) instead of
the standalone `serve()` listener. Pure Python, installs anywhere; it's a front-end
choice, orthogonal to which encoder you pick. See the
[ASGI / Starlette adapter](asgi.md) guide.

## 3. Host NVENC — `[nvenc]` + an NVIDIA GPU

```bash
pip install 'habemus-papadum-rfb[nvenc]'   # same PyAV wheel; NVENC rides its ffmpeg
```

Hardware H.264 through PyAV's bundled `h264_nvenc`. Needs a host **NVIDIA driver** +
an NVENC-capable card (pip can't install those). `serve()` auto-prefers it when
available. Frames originate on the **CPU**, so each one pays a CPU `rgb→yuv` reformat
+ a PCIe upload before the GPU encodes — see [Performance](performance.md); this is
why the GPU-resident paths below are much faster for GPU-rendered scenes.

## 4. GPU zero-copy — render on the GPU, encode with no host copy

If your frames are already on the GPU (CuPy / PyTorch / JAX), feed them straight to
NVENC. Two routes reach the same speed; **start with the SDK wheel**.

### 4a. NVENC SDK wheel — `[gpu-nvenc-sdk]` (recommended GPU path)

NVIDIA's Video Codec SDK encoder, packaged as the self-contained
**`habemus-papadum-nvenc`** wheel (`import pdum.nvenc`) — a prebuilt manylinux wheel
on **PyPI**. **No PyAV at all**, no compiler, no `LD_LIBRARY_PATH` — just the host
driver. One ABI-agnostic wheel ships both NVENC 12.1 and 13.0 builds and loads the
one your driver supports.

```bash
pip install 'habemus-papadum-rfb[gpu-nvenc-sdk]'   # pulls habemus-papadum-nvenc + cupy-cuda13x
# for a CUDA 12 toolkit, swap the CuPy half:
pip install 'habemus-papadum-rfb[gpu-nvenc-sdk]' cupy-cuda12x
```

Verify: `pdum-rfb doctor` should show **nvenc-gpu-pdum — NVENC SDK (pdum.nvenc): ✓** and recommend it.
This is the easiest GPU install **and** the fastest path measured on this hardware.

### 4b. PyAV 18 zero-copy — `[gpu-cuda13]` + PyAV ≥ 18

Feeds a CuPy/DLPack NV12 buffer to `h264_nvenc` via `VideoFrame.from_dlpack`. Same
hardware speed, but it needs **PyAV ≥ 18** (the encode-side `hw_frames_ctx` wiring),
which isn't on PyPI yet — so it's a build or a prebuilt-av wheel:

```bash
pip install 'habemus-papadum-rfb[gpu-cuda13]'   # CuPy (cupy-cuda12x for CUDA 12)
./scripts/install-gpu.sh                         # builds PyAV 18 (~1 min), or:
PYAV_WHEEL_URL=<release-url>/av-<...>.whl ./scripts/install-gpu.sh   # prebuilt
```

Full details (the PyAV-18 requirement, the from-source recipe, the gotchas) live in
[Zero-copy CUDA→NVENC](gpu_zerocopy.md). Prefer **4a** unless you specifically want
the PyAV/ffmpeg stack.

## Platform limits (read this for the GPU paths)

The GPU wheels are not universal. Current support, with everything else needing a
quick issue:

| Axis | Supported today | Notes |
| ---- | --------------- | ----- |
| **Python** | **3.14+** | the package's `requires-python`; CPython only |
| **OS** | **Linux** | NVENC paths; macOS/Windows untested for GPU |
| **Arch** | **amd64 (x86_64)** | aarch64 buildable but not yet published |
| **manylinux** | **`manylinux_2_34`** (local build) / **`manylinux_2_28`** (CI) | 2_28 installs on RHEL8 / Ubuntu 18.10+; 2_34 needs glibc ≥ 2.34 (Ubuntu 22.04+) |
| **CUDA** | **12.x or 13.x** | match the CuPy extra: `gpu-cuda12` vs `gpu-cuda13` |
| **GPU/driver** | NVIDIA, NVENC-capable, recent driver | not installable by pip; `libcuda`/`libnvidia-encode` come from the driver |

The CPU paths (core, `[h264]`) have none of these limits — they install wherever
PyAV/Pillow wheels do.

## Need broader support?

If your box is outside the matrix — **aarch64**, an older glibc (need
`manylinux_2_28`/`_2_17`), a different Python, macOS/Windows GPU, or a CUDA 11
toolkit — please **[open an issue](https://github.com/habemus-papadum/pdum_rfb/issues)**.
Both GPU wheels are built by on-demand CI workflows
(`build-nvenc-sdk-wheel`, `build-pyav-cuda-wheel`) that already accept a list of
Python versions and can target other manylinux tags, so adding a build is usually
cheap. In the issue, paste:

- the output of **`pdum-rfb doctor`**,
- `python -c "import platform,sys; print(sys.version, platform.machine())"`,
- your NVIDIA driver / CUDA toolkit version (`nvidia-smi`), and
- the wheel tag that failed to install (pip prints it as "not a supported wheel
  on this platform").

## What's on PyPI, what isn't

- **`habemus-papadum-nvenc` (SDK wheel) — on PyPI.** Its NVIDIA SDK source is MIT, so
  the wheel is clean to publish; the `[gpu-nvenc-sdk]` extra pulls it as a normal
  dependency. Maintainers publish it (and the rfb package) with `scripts/publish.sh`;
  CI only builds it as a validation artifact, never publishes.
- **PyAV 18 (`[gpu-cuda13]` route) — not on PyPI yet.** PyAV 18 itself is unreleased,
  and the CUDA-enabled build bundles **LGPL** ffmpeg, so it stays on this repo's
  **GitHub Releases**. Until PyAV 18.0 ships, use `scripts/install-gpu.sh` or a
  prebuilt av wheel from Releases; when it ships, the `[gpu-cuda13]` extra becomes a
  one-line `pip install` (just add `"av>=18"` to it).

PyPI forbids direct-reference (URL) dependencies in published packages, which is why
the PyAV-18 wheel can't be a plain transitive dependency today — but the SDK wheel
now can.
