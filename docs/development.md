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
  | `rendercanvas` | `rendercanvas` | the [rendercanvas backend](proposals/completed/rendercanvas_backend.md) (bring your own wgpu/pygfx) |
  | `cli` | `typer`, `rich` | `pdum-rfb doctor` / `pdum-rfb benchmark` |

  | Group | Pulls | For |
  | --- | --- | --- |
  | `dev` (default) | pytest, ruff, mkdocs(+plugins), hatch, av, pre-commit, … | everyday dev |
  | `viz` (default) | rendercanvas, wgpu, pygfx | exercise the rendercanvas backend / `examples/rendercanvas_pygfx.py` |
  | `gpu-dev` | CuPy | GPU tests/benchmarks on a machine with a device |

  `[tool.uv] default-groups = ["dev", "viz"]` makes `uv sync` install the `viz` render
  stack automatically on a dev box. The render test (`tests/test_rendercanvas_render.py`)
  uses Mesa **lavapipe** (software Vulkan) — `apt install mesa-vulkan-drivers` — so it runs
  GPU-free; it skips cleanly where no wgpu adapter exists. CI jobs that don't render pass
  `--no-group viz` to stay lean.

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
pnpm dev          # simple 2-process dev demo (see below): http://localhost:5173 (?ws=...&transport=image|video)
pnpm typecheck    # tsc for the library + worker (separate DOM / WebWorker lib configs)
pnpm test         # Vitest unit tests
pnpm build        # dist/index.js (+ .d.ts), worker inlined
pnpm e2e          # Playwright headless e2e (boots the Python server + demo)
pnpm build:demo   # build the `pdum-rfb demo` SPA -> src/pdum/rfb/static/demo/ (committed package data)
pnpm e2e:demo     # Playwright e2e that boots `pdum-rfb demo` and drives the web UI
```

### The two demos

* **User-facing:** `pdum-rfb demo` is a single self-contained web app (see
  [the demo page](demo.md)); end users run it with `uvx` — no clone, no Node. Its SPA
  lives in `widgets/packages/demo-app/` and is built to committed package data
  (`pnpm build:demo`); rebuild + commit it whenever that project changes.
* **Contributor-only:** the simple **two-process** demo — `python -m pdum.rfb.server`
  (streams a deterministic pattern on a bare WebSocket) plus `pnpm dev` (a minimal Vite
  client at `:5173`, `?ws=…&transport=image|video`) — is the quickest way to iterate on the
  core widget or the wire protocol. It also backs the Playwright e2e (`pnpm e2e`). This flow
  is not suggested to end users.

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
| `scripts/prepare-release.sh` | **Local half of a release**: validate, strip `-alpha`, bump every version file + repin the native extras in lockstep, commit, tag `vX.Y.Z`, push the tag (→ triggers CI publish). No tokens, no publishing. |
| `scripts/post-release.sh` | After CI is green: bump to the next `-alpha` dev version, commit, push `main`. |
| `scripts/_versioning.py` | Shared, stdlib-only version logic (discover/read/bump/write + extras repin) imported by the two scripts above. |
| `scripts/test_notebooks.sh` | Execute demo notebooks (`docs/demos/*.ipynb`). Run after editing any notebook. |
| `scripts/install-gpu.sh` | Build/install PyAV 18 (CUDA/NVENC) for the zero-copy path until PyAV 18 ships on PyPI. |
| `scripts/build-cuda-av-wheel.sh` | Build a self-contained PyAV-18 (CUDA) wheel. |
| `packages/nvenc/build-wheel.sh` · `packages/vtenc/build-wheel.sh` | Build the native `habemus-papadum-nvenc` (auditwheel) / `habemus-papadum-vtenc` (delocate) wheel(s). |
| `scripts/publish.sh` | **Manual fallback**: token-based publish of the three PyPI packages from a maintainer box. Not the primary path. |
| `scripts/release.sh` | Legacy all-in-one local release (interactive). Kept as a manual fallback; the primary path is `prepare-release.sh` + CI. |

## GitHub CI

Workflows live in `.github/workflows/`. Releases are **published from CI** by
`release.yml` (below) via PyPI **trusted publishing** (OIDC) + npm **provenance** —
no long-lived index tokens. The `build-*` workflows also run standalone as build-only
validation artifacts.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push / PR to `main` | Two jobs. **test**: `setup.sh`, ruff, install Mesa lavapipe, pytest + coverage (comment + badge — incl. the lavapipe `rendercanvas` render test), `mkdocs build`. **widgets**: pnpm typecheck, Vitest, and Playwright e2e (`uv sync --frozen --no-group viz` to boot the e2e test server). |
| `release.yml` | push tag `v*` | The release pipeline: builds the wheel matrix (`build-rfb` + reusable nvenc/vtenc), publishes npm (provenance) then PyPI (trusted publishing, `skip-existing`), and creates the GitHub Release. Triggered by `prepare-release.sh`. |
| `docs.yml` | on release published / push `main` / manual | Build the MkDocs site and deploy to GitHub Pages. |
| `gpu-tests.yml` | weekly (Mon) / manual | The **only** place GPU paths run in CI. Needs a self-hosted runner labelled `gpu`; runs `tests/test_gpu.py`, `pdum-rfb doctor`, and the benchmark. Stays queued if no such runner exists. |
| `build-nvenc-sdk-wheel.yml` · `build-vtenc-wheel.yml` | manual / `workflow_call` | Build the native `habemus-papadum-nvenc` (manylinux_2_28 + CUDA container) / `habemus-papadum-vtenc` (macOS arm64) wheels across CPython versions. Reused by `release.yml`; standalone runs are build-only (no GPU/Mac-runtime needed to *build*). |
| `build-pyav-cuda-wheel.yml` | manual / tag `gpu-av18-*` | Build the self-contained PyAV-18 (CUDA/NVENC) wheel; on a tag it attaches the wheels to a GitHub Release (LGPL ffmpeg — kept off PyPI). |

Normal CI runs **GPU-less**. The native wheel builds are expensive and **not** triggered
on pushes to `main`.

## Releasing (the pipeline)

Cross-platform reality: no single machine can build all three PyPI wheels
(`habemus-papadum-rfb` is pure Python; `-nvenc` is Linux+CUDA only; `-vtenc` is
macOS/arm64 only). So the release is **hybrid** — you cut it locally, CI builds the
matrix and publishes:

1. **`./scripts/prepare-release.sh <patch|minor|major>`** — validates, strips `-alpha`
   → `X.Y.Z`, bumps all 10 version files + repins the native extras (lockstep), commits,
   tags `vX.Y.Z`, and (after a confirm) **pushes the tag**.
2. **Pushing the tag triggers `release.yml`**, which in one run:
   - builds `rfb` (sdist+wheel), `nvenc` (manylinux), and `vtenc` (macOS arm64) in parallel;
   - **publishes npm** (core + wrappers, with provenance) — first, so a failure never
     half-publishes the immutable PyPI;
   - **publishes PyPI** (all three, one trusted-publishing call, `skip-existing`);
   - creates the **GitHub Release** (→ `docs.yml` redeploys Pages).
3. **`./scripts/post-release.sh <bump>`** — bump to the next `-alpha`, commit, push `main`.

If a CI step fails, see **[Release recovery](release_recovery.md)** — publishing is
idempotent and the same tag can be re-pushed.

### Versioning policy

- **Lockstep** — every published package shares one version, bumped together;
  `_versioning.py` enforces agreement across all 10 files.
- **npm `wrapper → core`** stays a `^` **peer** range (a range is correct for peer deps of
  adapter packages; exact-pinned peers cause "unmet peer" conflicts).
- **Python native extras** (`rfb[gpu-nvenc-sdk] → nvenc`, `rfb[mac-vt] → vtenc`) track the
  shared minor as **`~=X.Y.0`**, rewritten by the release scripts, so `rfb X.Y.*` resolves a
  matching native `X.Y.*` while patches still float.
- **Revisit at 1.0**: when native-package churn or diverging cadences bite, consider
  *grouped* (core+client lockstep; nvenc/vtenc independent) and/or Changesets.

### Trusted-publishing setup (one-time, maintainer)

CI publishing needs no long-lived PyPI token. Configure once:

- **PyPI trusted publishers** for each of the three projects (`pypi.org` → project →
  *Publishing* → add a GitHub publisher: owner `habemus-papadum`, repo `pdum_rfb`, workflow
  `release.yml`, environment `pypi`). For a brand-new project, use the **pending publisher**
  form before its first upload.
- A GitHub **environment named `pypi`** (optional protection rules as a release gate).
- **`NPM_TOKEN`** as an Actions secret (an npm *Automation*/granular token with write on the
  whole `@habemus-papadum` scope) — used for the provenance-signed npm publish. (npm OIDC
  trusted publishing is a later token-removal follow-up.) The four published `package.json`s
  carry a `repository` field, required for provenance.

### Manual fallback (`scripts/publish.sh` + `.env`)

`scripts/publish.sh` (and the legacy `scripts/release.sh`) publish from a maintainer box with
tokens in a **git-ignored `.env`** — use only for out-of-band publishing (a hotfix wheel, a
platform CI can't cover, or CI down). Off-platform native packages auto-skip; stitch in
CI-built wheels via `NVENC_WHEEL_DIR` / `VTENC_WHEEL_DIR`, or `SKIP_NVENC=1` / `SKIP_VTENC=1`.

```bash
# .env  (git-ignored — never commit)
HATCH_INDEX_USER=__token__
HATCH_INDEX_AUTH=pypi-…        # PyPI token; hatch does NOT read ~/.pypirc
UV_PUBLISH_TOKEN=pypi-…        # optional, for `uv publish`
NPM_TOKEN=npm_…                # npm token (materialized into a transient npmrc at publish)
```

> **Maintainers only.** `prepare-release.sh` pushes a tag that makes CI publish to PyPI/npm
> and create a public GitHub release; `release.sh`/`publish.sh` publish directly. Version
> numbers are human-managed — don't hand-edit them; let the release scripts bump them.
