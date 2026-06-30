#!/usr/bin/env bash
#
# build-cuda-av-wheel.sh — build a self-contained, distributable PyAV wheel with a
# CUDA-enabled ffmpeg bundled in, so users get the zero-copy CUDA->NVENC path with a
# plain `pip install <wheel>` — no system ffmpeg, no LD_LIBRARY_PATH, no compiler.
# (MAINTAINER tool. Upload the result to a GitHub release; see docs/gpu_zerocopy.md.)
#
# How it works:
#   1. fetch a BtbN LGPL "shared" ffmpeg (has h264_nvenc + the CUDA hwcontext, and
#      --disable-libx264 etc. -> no GPL components, clean to redistribute);
#   2. `pip wheel` PyAV from a pinned commit, linked against that ffmpeg;
#   3. `auditwheel repair` bundles the ffmpeg .so files into the wheel and rewrites
#      rpaths -> a self-contained manylinux wheel. libcuda / libnvidia-encode are NOT
#      bundled (they are dlopen'd from the host NVIDIA driver at runtime, as required).
#
# The bundled ffmpeg is LGPL; redistributing the wheel carries LGPL obligations
# (ship the corresponding ffmpeg source / build flags). It does not relink the GPU
# driver, which stays a host requirement.
#
set -euo pipefail

PYAV_COMMIT="${PYAV_COMMIT:-69ecd269c5b37caeafdff17aec0f0fefba834e61}"  # PyAV 18.0.0rc0
FFMPEG_URL="${FFMPEG_URL:-https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-lgpl-shared-8.1.tar.xz}"
PYTHON_VERSIONS="${PYTHON_VERSIONS:-3.14}"      # space-separated, e.g. "3.12 3.13 3.14"
OUT="${OUT:-dist/cuda-wheels}"                  # where the finished wheels land
WORK="${WORK:-$(mktemp -d)}"

say() { printf '\033[1;36m>>\033[0m %s\n' "$*"; }

# --- 1) CUDA ffmpeg (LGPL) --------------------------------------------------
FF="$WORK/ffmpeg"
say "fetching LGPL CUDA ffmpeg"
curl -fSL --retry 3 "$FFMPEG_URL" -o "$WORK/ff.tar.xz"
mkdir -p "$FF"; tar -C "$FF" --strip-components=1 -xf "$WORK/ff.tar.xz"
for pc in "$FF"/lib/pkgconfig/*.pc; do sed -i "s|^prefix=.*|prefix=$FF|" "$pc"; done
# sanity: must have the NVENC encoder (capture-then-match; piping to `grep -q` under
# `set -o pipefail` would SIGPIPE ffmpeg and give a false negative).
_encoders="$(LD_LIBRARY_PATH="$FF/lib" "$FF/bin/ffmpeg" -hide_banner -encoders 2>/dev/null || true)"
case "$_encoders" in
  *h264_nvenc*) ;;
  *) echo "ERROR: ffmpeg build lacks h264_nvenc"; exit 1 ;;
esac

mkdir -p "$OUT"
# --- 2+3) build + repair per Python version ---------------------------------
for pyver in $PYTHON_VERSIONS; do
  say "=== Python $pyver ==="
  bv="$WORK/build-$pyver"; raw="$WORK/raw-$pyver"; mkdir -p "$raw"
  uv venv "$bv" --python "$pyver" --seed -q
  say "  pip wheel PyAV @ ${PYAV_COMMIT:0:12} (linked to CUDA ffmpeg)"
  PKG_CONFIG_PATH="$FF/lib/pkgconfig" "$bv/bin/pip" wheel --no-binary av --no-deps \
    "av @ git+https://github.com/PyAV-Org/PyAV@${PYAV_COMMIT}" -w "$raw" >/dev/null
  say "  auditwheel repair (bundling ffmpeg)"
  LD_LIBRARY_PATH="$FF/lib" uv run --with auditwheel --with patchelf \
    auditwheel repair "$raw"/av-*.whl -w "$OUT" 2>&1 | grep -E "New filename tags|Fixed-up" || true
done

echo
say "wheels written to: $OUT"
ls -la "$OUT"/*.whl 2>/dev/null || true
cat <<EOF

Next steps:
  1. Upload the wheel(s) to a GitHub release of this repo, e.g.
       gh release create gpu-av18-<date> $OUT/av-*.whl \\
         --title "PyAV 18 (CUDA/NVENC) wheels" --notes "Self-contained; bundles LGPL ffmpeg."
  2. Users install with:
       uv pip install https://github.com/<owner>/<repo>/releases/download/<tag>/<wheel> cupy-cuda13x
     or point scripts/install-gpu.sh at it:
       PYAV_WHEEL_URL=<that url> ./scripts/install-gpu.sh
EOF
