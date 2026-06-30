#!/usr/bin/env bash
#
# build-wheel.sh — build habemus-papadum-nvenc (import: pdum.nvenc) into
# self-contained, repaired manylinux wheels. Build mechanism only; publishing to
# PyPI is done by scripts/publish.sh (which calls this). Also used by CI to produce
# build artifacts.
#
# How it works:
#   1. scikit-build-core drives CMake (FetchContent pulls pybind11 v3.0.4, and NVTX
#      v3.1.0) and builds the 12.1 + 13.0 NVENC ABI extensions against the CUDA
#      driver. NVIDIA's libnvidia-encode is dlopen'd, not linked.
#   2. auditwheel repair bundles the C/C++ runtime deps and tags the wheel manylinux,
#      EXCLUDING libcuda (host NVIDIA driver, as must be libnvidia-encode).
#
# Requires: a CUDA toolkit (cuda.h) + the NVIDIA driver on the build box, and network
# access (FetchContent). For broad manylinux_2_28 tags, run inside a manylinux+CUDA
# container (e.g. sameli/manylinux_2_28_x86_64_cuda_12.3); a stock box tags to its glibc.
#
# Usage:
#   ./build-wheel.sh                              # cp314 -> dist/ (NVTX ranges ON)
#   PYTHON_VERSIONS="3.12 3.13 3.14" ./build-wheel.sh
#   ./build-wheel.sh --no-nvtx                    # disable NVTX profiling ranges
#
set -euo pipefail
cd "$(dirname "$0")"

PYTHON_VERSIONS="${PYTHON_VERSIONS:-3.14}"
OUT="${OUT:-dist}"
WORK="${WORK:-$(mktemp -d)}"
# NVTX ranges are ON by default (header-only, no runtime lib, no-op without a profiler).
NVTX_DEFINE="ON"
case "${1:-}" in
  --no-nvtx) NVTX_DEFINE="OFF" ;;
  --nvtx) NVTX_DEFINE="ON" ;;
esac

say() { printf '\033[1;36m>>\033[0m %s\n' "$*"; }

mkdir -p "$OUT"
for pyver in $PYTHON_VERSIONS; do
  say "=== Python $pyver (USE_NVTX=$NVTX_DEFINE) ==="
  bv="$WORK/venv-$pyver"; raw="$WORK/raw-$pyver"; mkdir -p "$raw"
  uv venv "$bv" --python "$pyver" --seed -q
  say "  building wheel (scikit-build-core + CMake; both NVENC ABIs)"
  "$bv/bin/pip" wheel . --no-deps -w "$raw" \
    --config-settings=cmake.define.USE_NVTX="$NVTX_DEFINE" >/dev/null
  say "  auditwheel repair (exclude host driver libs)"
  LD_LIBRARY_PATH="/usr/local/cuda/lib64/stubs:${LD_LIBRARY_PATH:-}" \
    uv run --with auditwheel --with patchelf \
    auditwheel repair "$raw"/habemus_papadum_nvenc-*.whl -w "$OUT" \
    --exclude libcuda.so.1 --exclude libcuda.so 2>&1 \
    | grep -E "New filename tags|Fixed-up|excluded" || true
done

echo
say "wheels written to: $OUT"
ls -la "$OUT"/*.whl 2>/dev/null || true
say "publish with: scripts/publish.sh   (do not publish wheels straight from CI)"
