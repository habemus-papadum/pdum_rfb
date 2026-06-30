# Repository & Development

How this repository is laid out, the **uv** and **pnpm** conventions it follows,
and what each GitHub Actions workflow does. For the public API see the
[Python](guide_python.md) and [JavaScript](guide_javascript.md) guides; for the
design see [Internals](internals.md).

## Repository layout

This repo is a **uv workspace** that produces two Python packages plus one npm
package:

```text
pdum_rfb/
├── pyproject.toml            root package: habemus-papadum-rfb  (import: pdum.rfb)
├── uv.lock                   one lockfile for the whole workspace (committed)
├── src/pdum/rfb/             the published Python library (see Internals for the module map)
├── packages/
│   └── nvenc/                workspace member: habemus-papadum-nvenc (import: pdum.nvenc)
│       ├── pyproject.toml    native package (scikit-build-core); built only on demand
│       ├── src/cpp/          OUR pybind11 binding over NVIDIA's NvEncoderCuda (+ NVTX)
│       ├── src/pdum/nvenc/   OUR Python surface + the dual-ABI (12.1/13.0) loader
│       └── third_party/      VERBATIM, unmodified NVIDIA Video Codec SDK (MIT)
├── widgets/                  the browser client: @habemus-papadum/rfb-widgets (pnpm)
│   ├── src/                  RemoteFramebufferView + the Web Worker decoder
│   ├── tests/                Vitest unit tests + Playwright e2e
│   └── pnpm-lock.yaml        the widgets lockfile (committed)
├── docs/                     this MkDocs site
├── scripts/                  setup / build / test / publish / release automation
└── .github/workflows/        CI (see below)
```

`pdum` is a **PEP 420 implicit namespace package**: there is **no
`src/pdum/__init__.py`** in either package, so `habemus-papadum-rfb` can contribute
`pdum.rfb` and `habemus-papadum-nvenc` can contribute `pdum.nvenc` with no conflict
when both are installed. Don't add a `pdum/__init__.py`.

## Python: uv conventions

The project uses **uv exclusively**. Key rules:

- **`uv.lock` is committed** and authoritative. Install with `uv sync --frozen` so
  the lockfile is respected; CI does the same. Run tools through `uv run …` (e.g.
  `uv run pytest`, `uv run ruff check .`).
- **One workspace, one lock.** `[tool.uv.workspace] members = ["packages/*"]` and
  `[tool.uv.sources] habemus-papadum-nvenc = { workspace = true }` tie the root and
  member together. `uv lock` reads the member's static metadata only — a default
  `uv sync` (including CI) **never builds** the native nvenc package.
- **Extras vs groups.** *Optional dependencies* (extras) are user-facing install
  options; *dependency groups* are dev-only and not published.

  | Extra | Pulls | For |
  | --- | --- | --- |
  | `h264` | `av` (PyAV/libx264) | CPU/software H.264 |
  | `nvenc` | `av` | host-memory NVENC (same wheel; documents intent) |
  | `gpu-cuda12` / `gpu-cuda13` | CuPy | zero-copy CUDA→NVENC (needs PyAV ≥ 18) |
  | `gpu-nvenc-sdk` | `habemus-papadum-nvenc` + CuPy | PyAV-free GPU H.264 (recommended) |
  | `cli` | `typer`, `rich` | `pdum-rfb doctor` / `pdum-rfb benchmark` |

  | Group | Pulls | For |
  | --- | --- | --- |
  | `dev` (default) | pytest, ruff, mkdocs(+plugins), hatch, av, pre-commit, … | everyday dev |
  | `gpu-dev` | CuPy | GPU tests/benchmarks on a machine with a device |

- **The native member builds only when asked.** `habemus-papadum-nvenc` needs a
  CUDA toolkit (scikit-build-core); install it into the env with
  `uv sync --frozen --extra gpu-nvenc-sdk` (editable workspace install) or
  `uv pip install ./packages/nvenc`. On a Linux box with a GPU **and** a CUDA
  toolkit, `scripts/setup.sh` does this for you automatically — the `RFB_GPU`
  env var (`auto` default / `force` / `0`) controls it.
- **Lint/format:** ruff, `target-version = py314`, line length 120, rules `E/F/W/I`.
  Docstrings are **NumPy style** (mkdocstrings renders the API reference from them).
- **Versions are human-managed.** Never hand-edit version numbers; `scripts/release.sh`
  bumps them in lockstep (see [Releasing](#releasing-the-pipeline)).

## Browser client: pnpm conventions

The `widgets/` directory is a self-contained **pnpm** project (it carries its own
`widgets/pnpm-workspace.yaml` and `widgets/pnpm-lock.yaml` — it is *not* part of the
uv workspace). It needs **Node.js ≥ 20** (the Vite 6 / Vitest 3 toolchain);
`widgets/package.json` declares this via `engines.node`, the repo's root `.nvmrc`
pins the tested LTS (Node 22, used by CI), and `setup.sh` skips the browser client
on older Node. All commands run from `widgets/`:

```bash
pnpm install --frozen-lockfile   # respect the committed lockfile
pnpm exec playwright install chromium   # one-time: the browser the e2e suite drives
pnpm dev          # demo at http://localhost:5173 (?ws=...&transport=image|video)
pnpm typecheck    # tsc for the library + worker (separate DOM / WebWorker lib configs)
pnpm test         # Vitest unit tests
pnpm build        # dist/index.js (+ .d.ts), worker inlined
pnpm e2e          # Playwright headless e2e (boots the Python server + demo)
```

`scripts/setup.sh` runs both the `pnpm install` and the Playwright Chromium
download for you (Node.js + pnpm must already be on `PATH` — the script detects
them but does not install them). On Linux, if Chromium is missing system libraries,
re-run with `pnpm exec playwright install --with-deps chromium` (needs sudo).

The Web Worker is **inlined** into the published bundle (`?worker&inline`), so the
package works with any bundler — or none. The protocol packer (Python) and unpacker
(TS) are kept byte-compatible by **committed fixtures** in
`widgets/tests/fixtures/protocol/`, regenerated with `python -m pdum.rfb.testing
<dir>`; regenerate them if you change the wire envelope or headers.

## Automation scripts

| Script | What it does |
| --- | --- |
| `scripts/setup.sh` | Idempotent bootstrap: `uv sync --frozen` (auto-adds the `gpu-nvenc-sdk` extra on Linux+GPU+CUDA; `RFB_GPU=auto`/`force`/`0`), `pnpm install` + Playwright Chromium, pre-commit hooks. Detects but never installs uv/Node/pnpm. Rerun after pulling dependency changes. |
| `scripts/build.sh` | `uv sync` + build the widget bundle. |
| `scripts/pre-release.sh` | Clean-tree check, ruff, pytest, `mkdocs build`. |
| `scripts/test_notebooks.sh` | Execute demo notebooks (`docs/demos/*.ipynb`). Run after editing any notebook. |
| `scripts/install-gpu.sh` | Build/install PyAV 18 (CUDA/NVENC) for the zero-copy path until PyAV 18 ships on PyPI. |
| `scripts/build-cuda-av-wheel.sh` | Build a self-contained PyAV-18 (CUDA) wheel. |
| `packages/nvenc/build-wheel.sh` | Build the native `habemus-papadum-nvenc` wheel(s) via auditwheel. |
| `scripts/publish.sh` | Build + publish **both** Python packages to PyPI (see below). |
| `scripts/release.sh` | Orchestrate a full release of **all three** packages. |

## GitHub CI

Workflows live in `.github/workflows/`. **Publishing is never done from CI** — the
wheel-build workflows produce artifacts only; releases go out from a maintainer box
via `scripts/release.sh`.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push / PR to `main` | Two jobs. **test**: `setup.sh`, ruff, pytest + coverage (comment + badge), `mkdocs build`. **widgets**: pnpm typecheck, Vitest, and Playwright e2e (it `uv sync`s Python to boot the e2e test server). |
| `docs.yml` | on release published / manual | Build the MkDocs site and deploy to GitHub Pages. |
| `gpu-tests.yml` | weekly (Mon) / manual | The **only** place GPU paths run in CI. Needs a self-hosted runner labelled `gpu`; runs the `tests/test_gpu.py` tier, `pdum-rfb doctor`, and the benchmark. Stays queued (never runs on the hosted pool) if no such runner exists. |
| `build-nvenc-sdk-wheel.yml` | manual | Build `habemus-papadum-nvenc` wheels in a manylinux_2_28 + CUDA container as a validation artifact (no GPU needed to *build*). Build-only. |
| `build-pyav-cuda-wheel.yml` | manual / tag `gpu-av18-*` | Build the self-contained PyAV-18 (CUDA/NVENC) wheel; on a tag it also attaches the wheels to a GitHub Release (LGPL ffmpeg — kept off PyPI). |

Normal CI runs **GPU-less** and skips the GPU tests (they detect no device). The
two wheel-build workflows are expensive and deliberately **not** triggered on
pushes to `main`.

## Releasing (the pipeline)

`scripts/release.sh` bumps the version across **all four** version files in
lockstep — `pyproject.toml`, `src/pdum/rfb/__init__.py` (`__version__`),
`widgets/package.json`, and `packages/nvenc/pyproject.toml` — then (via an
interactive step selector) commits, tags, pushes, and publishes:

- **PyPI** — `scripts/publish.sh` builds and publishes **both** Python packages:
  `habemus-papadum-rfb` (hatch) and the native `habemus-papadum-nvenc` wheels
  (auditwheel'd, through the same `hatch publish`). Knobs: `SKIP_NVENC=1`,
  `NVENC_WHEEL_DIR=<dir>`, `NVENC_PYTHON_VERSIONS`.
- **npm** — builds and `pnpm publish`es `@habemus-papadum/rfb-widgets`.
- **GitHub Release** — which triggers `docs.yml` to redeploy the site.

### Credentials (`.env`)

Publishing is non-interactive when a **git-ignored `.env`** at the repo root
provides the credentials; `release.sh` loads it (and `publish.sh` sources it
independently). Pre-set environment variables always win.

```bash
# .env  (git-ignored — never commit)
HATCH_INDEX_USER=__token__
HATCH_INDEX_AUTH=pypi-…        # your PyPI token; hatch does NOT read ~/.pypirc
UV_PUBLISH_TOKEN=pypi-…        # optional, for `uv publish`
NPM_TOKEN=npm_…                # an npm *Automation* token (bypasses 2FA)
```

The npm token (`NPM_TOKEN`) lives **only** in `.env`. There is no committed or
persistent `.npmrc`: pnpm 11 refuses to expand `${NPM_TOKEN}` from a project-level
`.npmrc`, and keeping dev checkouts auth-config-free avoids the "failed to replace
env" / "credential could leak" warnings on every `pnpm` command. Instead,
`publish_to_npm()` in `scripts/release.sh` writes the resolved token to a transient,
`0600`, outside-the-repo file and points pnpm at it via `NPM_CONFIG_USERCONFIG` for
the publish call only (then deletes it). `widgets/package.json` sets
`publishConfig.access = "public"`, so the scoped package publishes publicly.

> **Maintainers only.** `scripts/release.sh` publishes to PyPI/npm, pushes tags,
> and creates public GitHub releases. Version numbers are human-managed — don't
> hand-edit them; let the release script bump them.
