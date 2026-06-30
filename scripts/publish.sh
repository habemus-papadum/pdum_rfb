#!/usr/bin/env bash
#
# publish.sh — build + publish this workspace's distributions to PyPI:
#   1. habemus-papadum-rfb  (root, pure Python)  — hatch build + publish
#   2. habemus-papadum-nvenc (packages/nvenc, native NVENC) — auditwheel'd manylinux
#      wheels, published through the SAME `hatch publish` (one credential path).
#   3. habemus-papadum-vtenc (packages/vtenc, native VideoToolbox) — delocate'd macOS
#      wheels, published through the same `hatch publish`.
#
# All go through PyPI from a maintainer box on purpose — publishing is NOT done from CI
# (CI only builds the native wheels as validation artifacts; see
# .github/workflows/build-nvenc-sdk-wheel.yml + build-vtenc-wheel.yml). release.sh calls
# this script.
#
# The two native packages build only on their own platform — nvenc on Linux+CUDA, vtenc
# on macOS — so no single box builds both. Each section auto-skips off its platform
# (publish that package's prebuilt CI wheels via *_WHEEL_DIR from the other box, or run
# publish.sh once per platform). The pure-Python rfb package publishes from anywhere.
#
# Knobs:
#   SKIP_NVENC=1 / SKIP_VTENC=1          publish only the rest (skip that native package)
#   NVENC_WHEEL_DIR=<dir> / VTENC_WHEEL_DIR=<dir>   publish prebuilt wheels from <dir>
#                             instead of building here (e.g. a CI artifact; the nvenc CI
#                             wheel is tagged manylinux_2_28 — broader than a local build)
#   NVENC_PYTHON_VERSIONS / VTENC_PYTHON_VERSIONS="3.12 3.13 3.14"   versions to build
#
# Building nvenc needs a CUDA toolkit; building vtenc needs the Xcode Command Line Tools.
# Both need network (FetchContent). A local nvenc build tags to this box's glibc (e.g.
# manylinux_2_34); for the broadest tag, point NVENC_WHEEL_DIR at the manylinux_2_28 CI
# artifact.
set -euo pipefail

OS="$(uname -s)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."

cd "$REPO_ROOT"

say() { printf '\033[1;36m>>\033[0m %s\n' "$*"; }

# Load local, git-ignored PyPI credentials so `hatch publish` is non-interactive
# (hatch reads HATCH_INDEX_USER/HATCH_INDEX_AUTH; it does NOT read ~/.pypirc).
# Pre-set env vars win (CI / one-off overrides); .env only fills what's unset.
if [ -f "$REPO_ROOT/.env" ]; then
  say "loading PyPI credentials from .env"
  while IFS= read -r _line; do
    case "$_line" in ''|\#*) continue ;; esac
    _key="${_line%%=*}"
    [ -z "${!_key:-}" ] && export "$_line"
  done < "$REPO_ROOT/.env"
fi

# --- 1) habemus-papadum-rfb (pure Python) -----------------------------------
say "habemus-papadum-rfb: build + publish"
rm -rf dist
uv run hatch build
uv run hatch publish

# --- 2) habemus-papadum-nvenc (native; packages/nvenc) ----------------------
# Wheels only, no sdist: an sdist on PyPI would make `pip install` try to compile
# (needs the CUDA toolkit) on platforms with no matching wheel, failing confusingly;
# absent an sdist, pip reports "no matching distribution" cleanly.
if [ "${SKIP_NVENC:-0}" = "1" ]; then
  say "habemus-papadum-nvenc: skipped (SKIP_NVENC=1)"
elif [ -n "${NVENC_WHEEL_DIR:-}" ]; then
  say "habemus-papadum-nvenc: publishing prebuilt wheels from $NVENC_WHEEL_DIR"
  uv run hatch publish "$NVENC_WHEEL_DIR"/*.whl
elif [ "$OS" != "Linux" ]; then
  say "habemus-papadum-nvenc: skipped (not Linux; build on a CUDA box or set NVENC_WHEEL_DIR / SKIP_NVENC=1)"
else
  say "habemus-papadum-nvenc: build (auditwheel) for ${NVENC_PYTHON_VERSIONS:-3.12 3.13 3.14}"
  rm -rf packages/nvenc/dist
  ( cd packages/nvenc && PYTHON_VERSIONS="${NVENC_PYTHON_VERSIONS:-3.12 3.13 3.14}" ./build-wheel.sh )
  say "habemus-papadum-nvenc: publish packages/nvenc/dist/*.whl"
  uv run hatch publish packages/nvenc/dist/*.whl
fi

# --- 3) habemus-papadum-vtenc (native; packages/vtenc) ----------------------
# Wheels only, no sdist (same rationale as nvenc): an sdist would make `pip install`
# try to compile the Objective-C++ extension on a non-macOS box and fail confusingly.
if [ "${SKIP_VTENC:-0}" = "1" ]; then
  say "habemus-papadum-vtenc: skipped (SKIP_VTENC=1)"
elif [ -n "${VTENC_WHEEL_DIR:-}" ]; then
  say "habemus-papadum-vtenc: publishing prebuilt wheels from $VTENC_WHEEL_DIR"
  uv run hatch publish "$VTENC_WHEEL_DIR"/*.whl
elif [ "$OS" != "Darwin" ]; then
  say "habemus-papadum-vtenc: skipped (not macOS; build on a Mac or set VTENC_WHEEL_DIR / SKIP_VTENC=1)"
else
  say "habemus-papadum-vtenc: build (delocate) for ${VTENC_PYTHON_VERSIONS:-3.12 3.13 3.14}"
  rm -rf packages/vtenc/dist
  ( cd packages/vtenc && PYTHON_VERSIONS="${VTENC_PYTHON_VERSIONS:-3.12 3.13 3.14}" ./build-wheel.sh )
  say "habemus-papadum-vtenc: publish packages/vtenc/dist/*.whl"
  uv run hatch publish packages/vtenc/dist/*.whl
fi
