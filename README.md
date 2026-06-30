# pdum.rfb — Remote Frame Buffer

[![CI](https://github.com/habemus-papadum/pdum_rfb/actions/workflows/ci.yml/badge.svg)](https://github.com/habemus-papadum/pdum_rfb/actions/workflows/ci.yml)
[![Coverage](https://raw.githubusercontent.com/habemus-papadum/pdum_rfb/python-coverage-comment-action-data/badge.svg)](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)
[![Documentation](https://img.shields.io/badge/Documentation-blue.svg)](https://habemus-papadum.github.io/pdum_rfb/)

[![PyPI](https://img.shields.io/pypi/v/habemus-papadum-rfb.svg)](https://pypi.org/project/habemus-papadum-rfb/)
[![Python 3.14+](https://img.shields.io/badge/python-3.14+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Code style: ruff](https://img.shields.io/badge/code%20style-ruff-000000.svg)](https://github.com/astral-sh/ruff)

**Render a framebuffer in Python, view and interact with it in the browser.**
`pdum.rfb` streams a server-rendered framebuffer to a browser over a WebSocket and
sends pointer/keyboard/resize events back. It targets **scientific and interactive
visualization** — sparse, on-demand-rendered scenes — rather than being a generic
VNC clone.

The repo ships two halves:

- a **Python server** — this package, `habemus-papadum-rfb` (`import pdum.rfb`),
  Python **3.14+**, UV-managed;
- a **browser client** — [`@habemus-papadum/rfb-widgets`](widgets/), a TypeScript
  package whose decoding runs entirely in a **Web Worker** (it owns the WebSocket,
  the decoder, and a transferred `OffscreenCanvas`).

A sibling native package, **`habemus-papadum-nvenc`** (`import pdum.nvenc`, under
[`packages/nvenc/`](packages/nvenc/)), provides an optional PyAV-free GPU H.264
encoder.

📖 **Full documentation: <https://habemus-papadum.github.io/pdum_rfb/>**

## How it works

The public API is **push**: you own your loop and publish frames into a shared
`Display`; the library fans each frame out to every connected viewer and lets you
drain input from all of them in one place.

```python
import asyncio
import pdum.rfb as rfb

async def main():
    display = await rfb.serve(1280, 720, port=8765)   # WS server starts in the background
    state = initial_state()
    try:
        while running(state):
            for ev in display.poll_events():          # input from every viewer
                state = update(state, ev)
            display.publish(render(state))            # sync, latest-wins, fans out to all viewers
            await asyncio.sleep(1 / 30)               # or on-demand — you own the cadence
    finally:
        await display.aclose()

asyncio.run(main())
```

```ts
import { RemoteFramebufferView } from "@habemus-papadum/rfb-widgets";
const view = new RemoteFramebufferView(document.getElementById("stage")!, {
  url: "ws://localhost:8765",
});
// later: view.dispose();
```

Each connecting browser negotiates the best shared transport: an **image path**
(JPEG/PNG/WebP, every frame a keyframe; dependency-light) or an **H.264 path**
(Annex B for the browser's WebCodecs decoder). For GPU-rendered scenes, three
hardware NVENC routes are available — see the
[Installation guide](https://habemus-papadum.github.io/pdum_rfb/installation/).

## Installation

```bash
pip install habemus-papadum-rfb              # image path (numpy, pillow, websockets)
pip install 'habemus-papadum-rfb[h264]'      # + CPU/software H.264 (PyAV/libx264)
pip install 'habemus-papadum-rfb[gpu-nvenc-sdk]'   # + GPU H.264 (NVIDIA, Linux) — fastest
```

`import pdum.rfb` works without any extra. Not sure what your machine supports?
`pip install 'habemus-papadum-rfb[cli]'` then `pdum-rfb doctor`. The full matrix
(CPU vs the three GPU routes, platform limits) is in the
[Installation guide](https://habemus-papadum.github.io/pdum_rfb/installation/).

## Developing

The repo is a **uv workspace** (root `habemus-papadum-rfb` + `packages/*`) with the
browser client as a self-contained **pnpm** project under `widgets/`. The layout,
the uv/pnpm conventions, and the CI are documented in
[Repository & Development](https://habemus-papadum.github.io/pdum_rfb/development/).

### Prerequisites

Install these yourself first — `setup.sh` **detects** them and tells you how to
install any that are missing, but it never installs them for you:

- [**uv**](https://docs.astral.sh/uv/) — `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **Node.js 20+ and pnpm** (for the browser client / e2e). The repo pins the tested
  LTS in [`.nvmrc`](.nvmrc) (Node 22, which CI uses) — `nvm use` / `fnm use` picks it
  up. `corepack enable` (ships with Node) or `npm i -g pnpm` provides pnpm. Optional
  if you only work on the Python side. `setup.sh` refuses to set up the browser
  client on Node < 20.

### Bootstrap (all platforms)

```bash
git clone https://github.com/habemus-papadum/pdum_rfb.git
cd pdum_rfb
./scripts/setup.sh        # idempotent — rerun after pulling dependency changes
```

One command sets up everything, the same way on macOS / Linux / Linux+GPU:

- **Python** — `uv sync --frozen` (the committed `uv.lock` is authoritative). On a
  Linux box with an NVIDIA GPU **and** a CUDA toolkit it auto-adds the native NVENC
  SDK encoder — see [Per-platform notes](#per-platform-notes) for the `RFB_GPU` knob.
- **Browser client** — `pnpm install --frozen-lockfile` plus the **Playwright
  Chromium** download used by the e2e suite (skipped, with a hint, if Node/pnpm are
  absent).
- **pre-commit hooks**.

### Per-platform notes

- **Linux without a GPU** (and CI's default) — the bootstrap above is everything.
  The `dev` group already includes PyAV, so the image and CPU-H.264 paths and all
  their tests work. GPU tests detect no device and skip.
- **Linux with an NVIDIA GPU** — `setup.sh` detects the GPU + CUDA toolkit and
  builds the PyAV-free **NVENC SDK encoder** (`pdum.nvenc`) as an editable install
  automatically. Override with the `RFB_GPU` env var:

  ```bash
  RFB_GPU=auto  ./scripts/setup.sh   # default: build it iff Linux + GPU + CUDA toolkit present
  RFB_GPU=force ./scripts/setup.sh   # build even if the CUDA major ≠ 13 (then swap CuPy yourself)
  RFB_GPU=0     ./scripts/setup.sh   # CPU paths only
  ```

  The `gpu-nvenc-sdk` extra pins `cupy-cuda13x`; on a CUDA-12 toolkit use
  `RFB_GPU=force` and swap to `cupy-cuda12x`. To confirm what lit up:

  ```bash
  uv run --group gpu-dev pdum-rfb doctor     # which encode paths are available
  ```

  For the PyAV-18 zero-copy route specifically, `./scripts/install-gpu.sh` builds a
  CUDA-enabled PyAV. See the
  [GPU zero-copy guide](https://habemus-papadum.github.io/pdum_rfb/gpu_zerocopy/).
- **macOS** — the image and CPU-H.264 paths work (PyAV publishes arm64 wheels). The
  NVENC/GPU paths are NVIDIA/Linux-only and are simply unavailable; everything else,
  including the full headless test suite for the CPU paths, runs normally.

### Common commands

```bash
uv run pytest                          # Python tests
uv run ruff check . && uv run ruff format .
uv run python -m pdum.rfb.server --pattern bouncing_box --port 8765   # demo server
uv run mkdocs serve                    # docs at http://localhost:8000

pnpm -C widgets typecheck              # browser client: types
pnpm -C widgets test                   #                 Vitest unit tests
pnpm -C widgets e2e                    #                 Playwright e2e (boots the Python server)
pnpm -C widgets dev                    #                 demo at http://localhost:5173
```

## Releasing

> **Maintainers only.** Releasing publishes to PyPI/npm, pushes tags, and creates
> public GitHub releases. Version numbers are human-managed — don't hand-edit them.

`./scripts/release.sh <patch|minor|major>` bumps the version across **all four**
version files in lockstep (`pyproject.toml`, `src/pdum/rfb/__init__.py`,
`widgets/package.json`, `packages/nvenc/pyproject.toml`), then — via an interactive
step selector — commits, tags, pushes, and publishes **all three packages**:

- **PyPI** — `scripts/publish.sh` publishes both `habemus-papadum-rfb` (hatch) and
  the native `habemus-papadum-nvenc` wheels.
- **npm** — `@habemus-papadum/rfb-widgets`.
- **GitHub Release** — which triggers the docs site to redeploy.

Publishing is **never** done from CI. It's non-interactive when a git-ignored
`.env` at the repo root supplies credentials (loaded by the release/publish
scripts; pre-set env vars win):

```bash
# .env  (git-ignored — never commit)
HATCH_INDEX_USER=__token__
HATCH_INDEX_AUTH=pypi-…     # PyPI token (hatch does NOT read ~/.pypirc)
NPM_TOKEN=npm_…             # npm *Automation* token (bypasses 2FA)
```

`release.sh` materializes `NPM_TOKEN` into a transient, outside-the-repo `.npmrc`
just for the `pnpm publish` call — there is no committed or persistent `.npmrc`, so
dev checkouts stay auth-config-free. Full mechanics and the CI overview are in
[Repository & Development](https://habemus-papadum.github.io/pdum_rfb/development/#releasing-the-pipeline).

## License

MIT License — see [LICENSE](LICENSE) for details.
