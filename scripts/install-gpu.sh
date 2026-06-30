#!/usr/bin/env bash
#
# install-gpu.sh — enable the zero-copy CUDA->NVENC path for pdum.rfb.
#
# The path needs CuPy + an NVENC GPU + PyAV >= 18 (the encode-side hw_frames_ctx
# wiring). Until PyAV 18.0 ships a wheel on PyPI, this script gets you there one of
# two ways into the *currently active* environment (or $PYTHON):
#
#   * PYAV_WHEEL_URL set  -> install that prebuilt, self-contained PyAV wheel
#                            (fastest: no build, no system ffmpeg, no env vars).
#                            Produce one with scripts/build-cuda-av-wheel.sh and host
#                            it on a GitHub release.
#   * otherwise           -> build PyAV from a pinned git commit against a CUDA-enabled
#                            ffmpeg (a BtbN LGPL shared build: has h264_nvenc + the CUDA
#                            hwcontext, no GPL components). The build bakes an rpath to
#                            the ffmpeg dir, so no LD_LIBRARY_PATH is needed at runtime.
#                            ~1 min the first time; uv caches the built wheel by commit,
#                            so re-installs on this box are instant.
#
# Override anything via env vars (see the block below). See docs/gpu_zerocopy.md.
#
set -euo pipefail

# --- configuration (override via environment) -------------------------------
PYAV_COMMIT="${PYAV_COMMIT:-69ecd269c5b37caeafdff17aec0f0fefba834e61}"  # PyAV 18.0.0rc0
CUPY_PACKAGE="${CUPY_PACKAGE:-cupy-cuda13x}"   # cupy-cuda12x for a CUDA 12 toolkit
FFMPEG_URL="${FFMPEG_URL:-https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-lgpl-shared-8.1.tar.xz}"
FF_PREFIX="${FF_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/pdum-rfb/ffmpeg}"
PYAV_WHEEL_URL="${PYAV_WHEEL_URL:-}"           # set to install a prebuilt wheel instead of building
PYTHON="${PYTHON:-}"                            # target interpreter; default = active env

say() { printf '\033[1;36m>>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

uvpip() { if [ -n "$PYTHON" ]; then uv pip install --python "$PYTHON" "$@"; else uv pip install "$@"; fi; }

# --- preflight: NVIDIA driver (capture-then-match; avoids a pipefail SIGPIPE) ---
_libs="$(ldconfig -p 2>/dev/null || true)"
case "$_libs" in
  *libcuda.so.1*) ;;
  *) [ -e /usr/lib/x86_64-linux-gnu/libcuda.so.1 ] \
       || warn "libcuda.so.1 not found — an NVIDIA driver + an NVENC-capable GPU are required at runtime." ;;
esac

# --- install PyAV (+ CuPy) ---------------------------------------------------
if [ -n "$PYAV_WHEEL_URL" ]; then
  say "installing prebuilt self-contained PyAV wheel:"
  say "  $PYAV_WHEEL_URL"
  uvpip "$PYAV_WHEEL_URL" "$CUPY_PACKAGE"
else
  say "no PYAV_WHEEL_URL set — building PyAV from source (commit ${PYAV_COMMIT:0:12})"

  # 1) CUDA-enabled ffmpeg dev tree (cached at $FF_PREFIX between runs)
  if [ ! -e "$FF_PREFIX/lib/pkgconfig/libavcodec.pc" ]; then
    say "fetching CUDA ffmpeg -> $FF_PREFIX"
    tmp="$(mktemp -d)"
    curl -fSL --retry 3 "$FFMPEG_URL" -o "$tmp/ff.tar.xz"
    tar -C "$tmp" -xf "$tmp/ff.tar.xz"
    inner="$(find "$tmp" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)"
    [ -n "$inner" ] || { warn "could not find extracted ffmpeg dir"; exit 1; }
    mkdir -p "$(dirname "$FF_PREFIX")"; rm -rf "$FF_PREFIX"; mv "$inner" "$FF_PREFIX"; rm -rf "$tmp"
    # BtbN hardcodes a build-machine prefix in the .pc files; repoint it.
    for pc in "$FF_PREFIX"/lib/pkgconfig/*.pc; do sed -i "s|^prefix=.*|prefix=$FF_PREFIX|" "$pc"; done
  else
    say "reusing CUDA ffmpeg at $FF_PREFIX"
  fi

  # 2) CuPy first (cached, fast), then PyAV.
  say "installing CuPy ($CUPY_PACKAGE)"
  uvpip "$CUPY_PACKAGE"

  # PyAV built against this ffmpeg, rpath baked so no LD_LIBRARY_PATH is needed at
  # runtime. --no-cache forces a fresh build: uv's build cache is keyed by the git
  # commit, NOT by the ffmpeg we link against (PKG_CONFIG_PATH/LDFLAGS), so a cached
  # wheel built against a different ffmpeg (or with no rpath) would otherwise be reused
  # silently. ~1 min; a one-time setup step.
  say "building PyAV against $FF_PREFIX (rpath-baked; no LD_LIBRARY_PATH needed)"
  PKG_CONFIG_PATH="$FF_PREFIX/lib/pkgconfig" LDFLAGS="-Wl,-rpath,$FF_PREFIX/lib" \
    uvpip --no-cache --reinstall-package av --no-binary av \
    "av @ git+https://github.com/PyAV-Org/PyAV@${PYAV_COMMIT}"
fi

# --- verify ------------------------------------------------------------------
say "verifying ..."
verify_py="${PYTHON:-python}"
"$verify_py" - <<'PY'
import sys
try:
    import pdum.rfb as r
    r.enable_cuda_context_sharing()
    ok = r.cuda_zerocopy_available()
    print(f"   zero-copy CUDA->NVENC available: {ok}")
    sys.exit(0 if ok else 2)
except ImportError:
    import av, cupy  # noqa: F401
    print(f"   av {av.__version__} + cupy {cupy.__version__} installed "
          "(install pdum.rfb in this env to self-test the full path)")
PY
say "done."
