#!/usr/bin/env bash
#
# publish.sh — build + publish this workspace's distributions to PyPI:
#   1. habemus-papadum-rfb  (root, pure Python)  — hatch build + publish
#   2. habemus-papadum-nvenc (packages/nvenc, native NVENC) — auditwheel'd manylinux
#      wheels, published through the SAME `hatch publish` (one credential path).
#
# Both go through PyPI from a maintainer box on purpose — publishing is NOT done from
# CI (CI only builds the nvenc wheel as a validation artifact; see
# .github/workflows/build-nvenc-sdk-wheel.yml). release.sh calls this script.
#
# Knobs:
#   SKIP_NVENC=1              publish only the rfb package (e.g. on a box without CUDA)
#   NVENC_WHEEL_DIR=<dir>     publish prebuilt nvenc wheels from <dir> instead of
#                             building here (e.g. the build-nvenc-sdk-wheel CI artifact,
#                             which is tagged manylinux_2_28 — broader than a local build)
#   NVENC_PYTHON_VERSIONS="3.12 3.13 3.14"   versions to build when building locally
#
# Building habemus-papadum-nvenc here needs a CUDA toolkit + network (FetchContent).
# A local build tags to this box's glibc (e.g. manylinux_2_34); for the broadest tag,
# point NVENC_WHEEL_DIR at the manylinux_2_28 CI artifact.
set -euo pipefail

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
else
  say "habemus-papadum-nvenc: build (auditwheel) for ${NVENC_PYTHON_VERSIONS:-3.12 3.13 3.14}"
  rm -rf packages/nvenc/dist
  ( cd packages/nvenc && PYTHON_VERSIONS="${NVENC_PYTHON_VERSIONS:-3.12 3.13 3.14}" ./build-wheel.sh )
  say "habemus-papadum-nvenc: publish packages/nvenc/dist/*.whl"
  uv run hatch publish packages/nvenc/dist/*.whl
fi
