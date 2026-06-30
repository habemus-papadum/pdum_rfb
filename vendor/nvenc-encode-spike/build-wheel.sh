#!/usr/bin/env bash
#
# build-wheel.sh — build the encode-only NVENC spike into a self-contained,
# hostable wheel (MAINTAINER tool). Upload the result to a GitHub release; the
# main package's install path / extra then points users at it.
#
# How it works:
#   1. scikit-build-core drives CMake (FetchContent pulls pybind11 v3.0.4, and
#      NVTX v3.1.0 if --nvtx) and links NVIDIA's verbatim SDK encoder against the
#      CUDA driver. NVIDIA's libnvidia-encode is dlopen'd, not linked.
#   2. auditwheel repair bundles the C/C++ runtime deps and tags the wheel
#      manylinux_2_28, EXCLUDING libcuda (it must come from the host NVIDIA
#      driver, as must libnvidia-encode).
#
# Requires: a CUDA toolkit (nvcc/cuda.h) + the NVIDIA driver on the build box,
# and network access (FetchContent). Build needs the toolkit; the *wheel* needs
# only the driver at runtime.
#
# Usage:
#   ./build-wheel.sh                       # cp314 by default
#   PYTHON_VERSIONS="3.12 3.13 3.14" ./build-wheel.sh
#   ./build-wheel.sh --nvtx                # profiling build (NVTX ranges on)
#
set -euo pipefail
cd "$(dirname "$0")"

PYTHON_VERSIONS="${PYTHON_VERSIONS:-3.14}"
OUT="${OUT:-dist}"
WORK="${WORK:-$(mktemp -d)}"
NVTX_DEFINE="OFF"
[ "${1:-}" = "--nvtx" ] && NVTX_DEFINE="ON"

say() { printf '\033[1;36m>>\033[0m %s\n' "$*"; }

mkdir -p "$OUT"
for pyver in $PYTHON_VERSIONS; do
  say "=== Python $pyver (USE_NVTX=$NVTX_DEFINE) ==="
  bv="$WORK/venv-$pyver"; raw="$WORK/raw-$pyver"; mkdir -p "$raw"
  uv venv "$bv" --python "$pyver" --seed -q
  say "  building wheel (scikit-build-core + CMake)"
  "$bv/bin/pip" wheel . --no-deps -w "$raw" \
    --config-settings=cmake.define.USE_NVTX="$NVTX_DEFINE" >/dev/null
  say "  auditwheel repair (exclude host driver libs)"
  LD_LIBRARY_PATH="/usr/local/cuda/lib64/stubs:${LD_LIBRARY_PATH:-}" \
    uv run --with auditwheel --with patchelf \
    auditwheel repair "$raw"/pdum_rfb_nvenc_sdk-*.whl -w "$OUT" \
    --exclude libcuda.so.1 --exclude libcuda.so 2>&1 \
    | grep -E "New filename tags|Fixed-up|excluded" || true
done

echo
say "wheels written to: $OUT"
ls -la "$OUT"/*.whl 2>/dev/null || true
cat <<EOF

Next steps:
  1. Upload to a GitHub release of this repo, e.g.
       gh release create nvenc-sdk-spike-<date> $OUT/pdum_rfb_nvenc_sdk-*.whl \\
         --title "NVENC SDK encode-only spike wheels" \\
         --notes "Self-contained; needs only the host NVIDIA driver. MIT + bundled NVIDIA SDK (MIT)."
  2. Install with:
       uv pip install <release-url>/pdum_rfb_nvenc_sdk-<...>.whl cupy-cuda13x
     (or via the habemus-papadum-rfb[gpu-nvenc-sdk] extra + the documented URL).
EOF
