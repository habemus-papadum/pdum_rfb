#!/usr/bin/env bash
#
# build-wheel.sh — build habemus-papadum-vtenc (import: pdum.vtenc) into a
# self-contained, repaired macOS wheel. Build mechanism only; publishing to PyPI is
# done by scripts/publish.sh (which calls this). Also used by CI to produce artifacts.
#
# How it works:
#   1. scikit-build-core drives CMake (FetchContent pulls pybind11 v3.0.4) and builds
#      the _vtenc Objective-C++ extension against the macOS system frameworks
#      (VideoToolbox/CoreVideo/CoreMedia). Nothing NVIDIA/CUDA; nothing vendored.
#   2. delocate-wheel repairs + tags the wheel. Because the extension links only system
#      frameworks (analogous to libcuda on the NVENC side), there is nothing to bundle —
#      delocate just validates and applies the macosx_*_arm64 platform tag.
#
# Requires: macOS + Xcode Command Line Tools (clang + the macOS SDK), and network access
# (FetchContent). The full Metal toolchain (Xcode) is NOT needed — v1 has no Metal kernel.
#
# Usage:
#   ./build-wheel.sh                              # cp314 -> dist/
#   PYTHON_VERSIONS="3.12 3.13 3.14" ./build-wheel.sh
#
set -euo pipefail
cd "$(dirname "$0")"

PYTHON_VERSIONS="${PYTHON_VERSIONS:-3.14}"
OUT="${OUT:-dist}"
WORK="${WORK:-$(mktemp -d)}"

say() { printf '\033[1;36m>>\033[0m %s\n' "$*"; }

mkdir -p "$OUT"
for pyver in $PYTHON_VERSIONS; do
  say "=== Python $pyver ==="
  bv="$WORK/venv-$pyver"; raw="$WORK/raw-$pyver"; mkdir -p "$raw"
  uv venv "$bv" --python "$pyver" --seed -q
  say "  building wheel (scikit-build-core + CMake)"
  "$bv/bin/pip" wheel . --no-deps -w "$raw" >/dev/null
  # delocate reads the raw wheel and writes a repaired, retagged wheel to $OUT. The
  # extension links only system frameworks, so nothing is bundled — the value is the
  # macosx_<deployment-target> retag (a plain `pip wheel` tags to the build box's OS,
  # which would needlessly restrict the wheel to that macOS version).
  say "  delocate-wheel (retag to the deployment target; system frameworks bundle nothing)"
  uv run --with delocate delocate-wheel -w "$OUT" "$raw"/habemus_papadum_vtenc-*.whl
done

echo
say "wheels written to: $OUT"
ls -la "$OUT"/*.whl 2>/dev/null || true
say "publish with: scripts/publish.sh   (do not publish wheels straight from CI)"
