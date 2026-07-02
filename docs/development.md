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
  | `gpu-nvenc-sdk` | `habemus-papadum-nvenc` | PyAV-free GPU H.264 (recommended; add `gpu-cuda13` for the zero-copy frame path) |
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
- **Versions are human-managed.** Never hand-edit version numbers; the `release` workflow
  bumps them in lockstep (via `scripts/_versioning.py`). Between releases the tree carries an
  `X.Y.Z+dev` marker (see [Releasing](#releasing-the-pipeline)).

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
pnpm build:demo   # build the `pdum-rfb demo` SPA -> src/pdum/rfb/static/demo/ (git-ignored build artifact)
pnpm e2e:demo     # Playwright e2e that boots `pdum-rfb demo` and drives the web UI
```

### The two demos

* **User-facing:** `pdum-rfb demo` is a single self-contained web app (see
  [the demo page](demo.md)); end users run it with `uvx` — no clone, no Node. Its SPA
  lives in `widgets/packages/demo-app/`. Its built SPA is **not committed** — it's a
  git-ignored build artifact (`pnpm build:demo`) force-included into the wheel by
  `hatch_build.py` when present. The release CI builds it before packaging, and
  `scripts/setup.sh` builds it for dev; a checkout without it serves a "build me"
  placeholder (or use `pdum-rfb demo --dev` for live reload). No need to rebuild + commit.
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
| `scripts/pre-release.sh` | Clean-tree check, ruff, pytest, `mkdocs build` (a local pre-flight; the release itself is CI-only). |
| `scripts/_versioning.py` | Shared, stdlib-only version logic (discover/read/bump/write + extras repin + tag-as-truth + `+dev`). The `release` workflow drives it via its CLI (`compute-release` / `set` / `latest-tag`); **not** a local release script. |
| `scripts/test_notebooks.sh` | Execute demo notebooks (`docs/demos/*.ipynb`). Run after editing any notebook. |
| `scripts/install-gpu.sh` | Build/install PyAV 18 (CUDA/NVENC) for the zero-copy path until PyAV 18 ships on PyPI. |
| `scripts/build-cuda-av-wheel.sh` | Build a self-contained PyAV-18 (CUDA) wheel. |
| `packages/nvenc/build-wheel.sh` · `packages/vtenc/build-wheel.sh` | Build the native `habemus-papadum-nvenc` (auditwheel) / `habemus-papadum-vtenc` (delocate) wheel(s). |
| `scripts/publish.sh` | **Break-glass fallback**: token-based publish of the three PyPI packages from a maintainer box. Not the primary path — the `release` workflow is. |

## GitHub CI

Workflows live in `.github/workflows/`. Releasing is **entirely CI** — the `release.yml`
`workflow_dispatch` (below) is the single publish path; there is no local release script and no
tag trigger. The `build-*` workflows also run standalone as build-only validation artifacts.

> **⚠️ Temporary (2026):** PyPI + npm publish with **token secrets** (`PYPI_API_TOKEN`,
> `NPM_TOKEN`), not trusted publishing (OIDC) — the maintainer is locked out of the PyPI account
> (lost 2FA recovery codes) and can't register trusted publishers yet. Migration back is tracked
> in [`proposals/active/trusted_publishing_migration.md`](proposals/active/trusted_publishing_migration.md).

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push / PR to `main` (+ manual) | **The per-commit gate the release requires green.** **test** (Python 3.14): `setup.sh`, ruff, pytest + coverage (incl. the lavapipe `rendercanvas` render test), `mkdocs build`, demo notebooks. **pytest-versions**: re-runs pytest on 3.12 + 3.13 (enforces `requires-python`). **widgets**: pnpm typecheck, Vitest, Playwright e2e. |
| `release.yml` | **manual** (`workflow_dispatch`: `bump`/`skip_ci_check`/`dry_run`) | The whole release pipeline: **require the commit's `ci.yml` green (gate)** → compute version from the last tag → bump+tag+push → build the wheel matrix (`build-rfb` + reusable nvenc/vtenc) from the tag → publish npm (provenance) then PyPI (token, `skip-existing`) → GitHub Release → return `main` to `+dev`. Run by a human; no tag trigger. |
| `docs.yml` | on release published / push `main` / manual | Build the MkDocs site and deploy to GitHub Pages. |
| `gpu-tests.yml` | weekly (Mon) / manual | The **only** place GPU paths run in CI. Needs a self-hosted runner labelled `gpu`; runs `tests/test_gpu.py`, `pdum-rfb doctor`, and the benchmark. Stays queued if no such runner exists. |
| `macos-probe.yml` | weekly (Mon) / manual | Informational, non-blocking macOS **VideoToolbox** capability probe (arm64 runner) — off the per-push path (macOS minutes bill 10×). The MLX/Metal tests were dropped: hosted runners don't expose a working Metal GPU, so those only ever stalled. |
| `build-nvenc-sdk-wheel.yml` · `build-vtenc-wheel.yml` | manual / `workflow_call` | Build the native `habemus-papadum-nvenc` (manylinux_2_28 + CUDA container) / `habemus-papadum-vtenc` (macOS arm64) wheels across CPython versions. Reused by `release.yml`; standalone runs are build-only (no GPU/Mac-runtime needed to *build*). |
| `build-pyav-cuda-wheel.yml` | manual / tag `gpu-av18-*` | Build the self-contained PyAV-18 (CUDA/NVENC) wheel; on a tag it attaches the wheels to a GitHub Release (LGPL ffmpeg — kept off PyPI). |

Normal CI runs **GPU-less**. The native wheel builds are expensive and **not** triggered
on pushes to `main`.

## Releasing (the pipeline)

Releasing is a **single CI workflow** — `release.yml`, a `workflow_dispatch` a maintainer runs
from the GitHub Actions UI (**Actions → release → Run workflow**) or `gh workflow run
release.yml -f bump=minor`. There is no local release script and no `v*` tag trigger, so the old
"local publish *and* CI publish the same version" double-publish is impossible.

This solves the cross-platform reality — no single machine can build all three PyPI wheels
(`habemus-papadum-rfb` is pure Python; `-nvenc` is Linux+CUDA only; `-vtenc` is macOS/arm64
only) — by having CI build the matrix. Inputs:

- **`bump`** = `patch` / `minor` / `major` — the release **size relative to the last release**.
- **`skip_ci_check`** (default false) — override the gate and release even if the commit's CI
  isn't green (or hasn't run). Normally leave it off.
- **`dry_run`** (default false) — compute the version and print the file diff, then **stop**
  (no commit, tag, build, or publish). A rehearsal.

The release **does not re-run tests** — it trusts CI. One dispatch runs, in order:

1. **`gate`** (unless `skip_ci_check`) — require the commit's `ci.yml` run (Linux `test` +
   `pytest-versions` + `widgets`) to be green; **waits out** an in-progress run (up to 30 min),
   so dispatching right after a push is fine. A red or missing CI run blocks the release.
2. **`prepare`** — `version = bump(last vX.Y.Z tag, bump)` (tag-as-truth), writes it across all
   10 version files + repins the native extras (lockstep, `scripts/_versioning.py`), `uv lock`,
   commits, tags `vX.Y.Z`, and pushes the commit + tag to `main`.
3. **`build-rfb` / `build-nvenc` / `build-vtenc`** — build `rfb` (sdist+wheel), `nvenc`
   (manylinux), `vtenc` (macOS arm64) **from the freshly-pushed tag**, in parallel.
4. **`npm-publish`** — core + wrappers, with provenance — *first*, so a failure never
   half-publishes the immutable PyPI.
5. **`pypi-publish`** — all three, one call, `skip-existing` (idempotent).
6. **`github-release`** (→ `docs.yml` redeploys Pages) and **`finalize`** — set `main` back to
   the `X.Y.Z+dev` working marker.

If a step fails, see **[Release recovery](release_recovery.md)** — publishing is idempotent
(`skip-existing`); fix and re-dispatch, or finish the remaining pieces by hand.

### Versioning model — tag-as-truth + `+dev`

The **last release** is the highest `vX.Y.Z` git tag. The `bump` (patch/minor/major) is applied
**at release time** against that tag — so you decide the size of a release *when you cut it*,
relative to what actually shipped, never pre-committing a version a release ahead. Between
releases the working tree carries an **`X.Y.Z+dev`** marker (the last release + a WIP flag): a
PEP 440 *local* version that sorts after `X.Y.Z`, that pnpm accepts, and that **PyPI refuses to
upload** — an accidental-publish guard. The release writes the clean `X.Y.Z` before building
(artifacts are never `+dev`), then `finalize` returns `main` to `<new>+dev`.

- **Lockstep** — every published package shares one version; `_versioning.py` enforces
  agreement across all 10 files.
- **npm `wrapper → core`** stays a `^` **peer** range (correct for adapter peer deps;
  exact-pinned peers cause "unmet peer" conflicts).
- **Python native extras** (`rfb[gpu-nvenc-sdk] → nvenc`, `rfb[mac-vt] → vtenc`) track the
  shared minor as **`~=X.Y.0`**, rewritten on every version write (marker-preserving), so
  `rfb X.Y.*` resolves a matching native `X.Y.*` while patches float.
- **Revisit at 1.0**: when native-package churn or diverging cadences bite, consider *grouped*
  (core+client lockstep; nvenc/vtenc independent) and/or a tool like Changesets / release-please.

### Publishing auth (token secrets, temporary)

CI publishes with two repository secrets — **`PYPI_API_TOKEN`** and **`NPM_TOKEN`** — while the
maintainer is locked out of PyPI 2FA. The `npm-publish` job keeps `id-token: write` for
**provenance** only (independent of the token auth); the four published `package.json`s carry a
`repository` field, required for provenance. The intended end state is OIDC **trusted
publishing** (no long-lived tokens) — the full migration runbook (register PyPI publishers, the
`pypi` environment, `npm trust`, rotate/revoke) is
[`proposals/active/trusted_publishing_migration.md`](proposals/active/trusted_publishing_migration.md).

### Break-glass fallback (`scripts/publish.sh` + `.env`)

`scripts/publish.sh` publishes from a maintainer box with tokens in a **git-ignored `.env`** —
use only for out-of-band publishing (a hotfix wheel, a platform CI can't cover, or CI down). Off-
platform native packages auto-skip; stitch in CI-built wheels via `NVENC_WHEEL_DIR` /
`VTENC_WHEEL_DIR`, or `SKIP_NVENC=1` / `SKIP_VTENC=1`.

```bash
# .env  (git-ignored — never commit)
HATCH_INDEX_USER=__token__
HATCH_INDEX_AUTH=pypi-…        # PyPI token; hatch does NOT read ~/.pypirc
UV_PUBLISH_TOKEN=pypi-…        # optional, for `uv publish`
NPM_TOKEN=npm_…                # npm token (materialized into a transient npmrc at publish)
```

> **Maintainers only.** Dispatching `release.yml` publishes to PyPI/npm and creates a public
> GitHub release; `publish.sh` publishes directly. Version numbers are human-managed — don't
> hand-edit them; the release workflow bumps them.
