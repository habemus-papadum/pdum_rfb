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
├── scripts/                  setup / build / test automation (releases: ship, see below)
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
  | `dev` (default) | pytest, ruff, mkdocs(+plugins), av, pre-commit, ship, … | everyday dev |
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
- **Versions belong to ship.** Never hand-edit a version field; `ship release` writes it on the
  release commit, one package at a time. Between releases each manifest carries
  `<last release>+dev` (see [Releasing](#releasing)).

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
  git-ignored build artifact (`pnpm build:demo`) that the hatch `artifacts` list lets into
  the wheel when present. ship builds it before packaging the wheel (the package's
  `before-build` commands), and `scripts/setup.sh` builds it for dev; a checkout without it serves a "build me"
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
| `scripts/test_notebooks.sh` | Execute demo notebooks (`docs/demos/*.ipynb`). Run after editing any notebook. |
| `scripts/install-gpu.sh` | Build/install PyAV 18 (CUDA/NVENC) for the zero-copy path until PyAV 18 ships on PyPI. |
| `scripts/build-cuda-av-wheel.sh` | Build a self-contained PyAV-18 (CUDA) wheel. |
| `packages/nvenc/build-wheel.sh` · `packages/vtenc/build-wheel.sh` | Build the native `habemus-papadum-nvenc` (auditwheel) / `habemus-papadum-vtenc` (delocate) wheel(s); the `build-*-wheel.yml` workflows call them. |

There is no release or publish script: `ship` (installed in the dev group) releases, and the
`release` workflow runs it.

## GitHub CI

Workflows live in `.github/workflows/`. Releasing is **entirely CI** — the `release.yml`
`workflow_dispatch` (below) is the publish path for every package; nothing publishes from a
developer machine. The `build-*-wheel` workflows build the two native packages from their
release tags and otherwise run standalone as build-only validation.

> **⚠️ Temporary (2026):** PyPI + npm publish with **token secrets** (`PYPI_API_TOKEN`,
> `NPM_TOKEN`), not trusted publishing (OIDC) — the maintainer is locked out of the PyPI account
> (lost 2FA recovery codes) and can't register trusted publishers yet. Migration back is tracked
> in [`proposals/active/trusted_publishing_migration.md`](proposals/active/trusted_publishing_migration.md).

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push / PR to `main` (+ manual) | **The per-commit gate the release requires green.** **test** (Python 3.14): `setup.sh`, ruff, pytest + coverage (incl. the lavapipe `rendercanvas` render test), `mkdocs build`, demo notebooks. **pytest-versions**: re-runs pytest on 3.12 + 3.13 (enforces `requires-python`). **widgets**: `ship deps check`, pnpm typecheck, Vitest, Playwright e2e. |
| `release.yml` | **manual** (`workflow_dispatch`: `package`/`bump`/`dry_run`/`skip_ci_check`/`skip_tests`) | Calls ship's reusable workflow: **require the commit's `ci.yml` green** → `ship release <package>` (version from the package's last tag + bump → `before-build` → build → tests → publish → commit + tag `<package>-v<version>` + push → GitHub Release → `<version>+dev` back). For `habemus-papadum-nvenc`/`-vtenc` a second job dispatches the package's `build-*-wheel` workflow for the new tag. |
| `docs.yml` | push `main` / manual | Build the MkDocs site and deploy to GitHub Pages. |
| `gpu-tests.yml` | weekly (Mon) / manual | The **only** place GPU paths run in CI. Needs a self-hosted runner labelled `gpu`; runs `tests/test_gpu.py`, `pdum-rfb doctor`, and the benchmark. Stays queued if no such runner exists. |
| `macos-probe.yml` | weekly (Mon) / manual | Informational, non-blocking macOS **VideoToolbox** capability probe (arm64 runner) — off the per-push path (macOS minutes bill 10×). The MLX/Metal tests were dropped: hosted runners don't expose a working Metal GPU, so those only ever stalled. |
| `build-nvenc-sdk-wheel.yml` · `build-vtenc-wheel.yml` | tag `habemus-papadum-nvenc-v*` / `habemus-papadum-vtenc-v*`, manual (`ref`), `workflow_call` | Build the native `habemus-papadum-nvenc` (manylinux_2_28 + CUDA container) / `habemus-papadum-vtenc` (macOS arm64) wheels across CPython versions. When the ref is the package's release tag, a `publish` job uploads them to PyPI (`uv publish`, `PYPI_API_TOKEN`) and attaches them to the GitHub release ship created. Other runs are build-only (no GPU/Mac-runtime needed to *build*). |
| `build-pyav-cuda-wheel.yml` | manual / tag `gpu-av18-*` | Build the self-contained PyAV-18 (CUDA/NVENC) wheel; on a tag it attaches the wheels to a GitHub Release (LGPL ffmpeg — kept off PyPI). |

Normal CI runs **GPU-less**. The native wheel builds are expensive and **not** triggered
on pushes to `main`.

## Releasing

Releases run with [ship](https://github.com/habemus-papadum/pdum_ship) (`habemus-papadum-ship`,
installed in the dev group) from the `release` workflow — `gh workflow run release.yml
-f package=<name> -f bump=minor -f dry_run=true`, then the same with `dry_run=false`, or
**Actions → release → Run workflow**. Nothing publishes from a developer machine.

ship's model, in short:

- **One version per package.** This repository publishes seven packages, each with its own
  version in its own manifest and its own tag series `<package>-v<version>`: the PyPI
  distributions `habemus-papadum-rfb` (`pyproject.toml`), `habemus-papadum-nvenc` and
  `habemus-papadum-vtenc` (`packages/*/pyproject.toml`), and the npm packages
  `@habemus-papadum/rfb-widgets` (`widgets/package.json`), `rfb-react`, `rfb-svelte` and
  `rfb-solid` (`widgets/packages/*/package.json`; tags use the unscoped name, `rfb-react-v0.3.1`).
  The private workspace members (`rfb-ui`, `worker-observability`, `demo-app`) carry `0.0.0` and
  are never released.
- **The tag is the truth.** The next version is the package's last tag plus the `bump` you
  choose at release time; the manifest is never trusted for this.
- **`<last release>+dev` between releases.** A PEP 440 local version / semver build metadata
  that PyPI refuses and ship refuses to publish, so a development build cannot ship by accident.
- **Floors on our own packages.** `habemus-papadum-rfb`'s native extras declare
  `habemus-papadum-nvenc>=0.3.0` / `habemus-papadum-vtenc>=0.3.0`; the wrappers declare the
  core as a peer, `workspace:>=0.3.0`, published as `>=0.3.0`. An exact pin needs a reason on
  the same line or in `[tool.ship.pins]`.

Inputs: **`package`** (npm packages by their scoped name), **`bump`** = `patch` / `minor` /
`major`, **`dry_run`** (default **true**: plan and print, write nothing), **`skip_ci_check`**
and **`skip_tests`** (normally off). One dispatch:

1. waits for the commit's `ci.yml` run to succeed (`skip_ci_check` overrides);
2. `ship release <package> --bump <bump>`: reads the package's last tag, writes the release
   version (`uv version --package` for Python, so `uv.lock` follows; `package.json` in place for
   npm), runs the package's `before-build` commands — for `habemus-papadum-rfb` the anywidget
   bundle and the demo SPA, which hatch packs into the wheel — builds, runs the
   tests, publishes (`uv publish` / `pnpm publish --provenance` with `PYPI_API_TOKEN` /
   `NPM_TOKEN`), commits, tags `<package>-v<version>`, pushes commit and tag together, creates
   the GitHub release, then writes `<version>+dev` back and pushes;
3. for `habemus-papadum-nvenc` / `-vtenc` (`build = false` in `[tool.ship.packages]`, because
   the Linux release runner cannot build a CUDA or a VideoToolbox wheel) step 2 builds and
   uploads nothing, and a `build-wheels` job dispatches `build-nvenc-sdk-wheel.yml` /
   `build-vtenc-wheel.yml` with `ref=<the new tag>`; that workflow builds the wheels, publishes
   them to PyPI and attaches them to the GitHub release.

Locally, `uv run ship release habemus-papadum-rfb --bump minor --dry-run` prints the plan;
`uv run ship packages` lists the packages with their manifest versions and last tags;
`uv run ship changed` lists the packages with commits since their last tag; `uv run ship deps
check` reports development links, stale lockfiles, unreasoned pins and manifests that do not
say `<last tag>+dev` (CI runs it in the `widgets` job, the `ship-check` pre-commit hook runs
its fast subset). Configuration is `[tool.ship]` in `pyproject.toml`: `ours`, `shared-paths`,
`ignore-subjects`, `pnpm-root = "widgets"` (the pnpm workspace is nested), and the per-package
`before-build` / `build = false` tables.

If a step fails, see **[Release recovery](release_recovery.md)**.

### Publishing auth (token secrets, temporary)

CI publishes with two repository secrets — **`PYPI_API_TOKEN`** and **`NPM_TOKEN`** — while the
maintainer is locked out of PyPI 2FA. The release caller grants `id-token: write` for
**provenance** only (independent of the token auth); the four published `package.json`s carry a
`repository` field, required for provenance. The intended end state is OIDC **trusted
publishing** (no long-lived tokens) — the migration runbook (register PyPI publishers, the
`pypi` environment, `npm trust`, rotate/revoke) is
[`proposals/active/trusted_publishing_migration.md`](proposals/active/trusted_publishing_migration.md);
its `release.yml` job names predate ship.

> **Maintainers only.** Dispatching `release.yml` with `dry_run=false` publishes to PyPI/npm
> and creates a public GitHub release. Never hand-edit a version field; ship writes it.
