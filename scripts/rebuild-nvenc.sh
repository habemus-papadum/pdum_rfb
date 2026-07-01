#!/usr/bin/env bash

# rebuild-nvenc.sh — force a fresh native build of habemus-papadum-nvenc (import:
# pdum.nvenc) into THIS project's .venv after you edit its C++.
#
# Why this exists: `uv sync` caches the editable build keyed by *version*, so after you
# edit packages/nvenc/src/cpp/*.cpp (or the vendored NVENC SDK) a plain `uv sync` reuses
# the stale .so without re-running CMake/nvcc. This reinstalls only that one package with
# a busted cache so it actually recompiles, and targets ./.venv explicitly (with any
# active $VIRTUAL_ENV stripped) so the build can't land in the wrong environment.
#
# First-time install (not a rebuild) is still: RFB_GPU=force uv sync --extra gpu-nvenc-sdk

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV="${REPO_ROOT}/.venv"

if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "error: ${VENV} not found." >&2
  echo "  Run ./scripts/setup.sh, or: RFB_GPU=force uv sync --extra gpu-nvenc-sdk" >&2
  exit 1
fi

echo "Rebuilding habemus-papadum-nvenc into ${VENV} (fresh CMake/nvcc build)..."
env -u VIRTUAL_ENV uv pip install \
  --reinstall-package habemus-papadum-nvenc \
  --no-deps --no-cache \
  --python "${VENV}/bin/python" \
  "${REPO_ROOT}/packages/nvenc"

echo "Verifying import..."
env -u VIRTUAL_ENV "${VENV}/bin/python" - <<'PY'
from pdum.nvenc import NvencEncoder
present = [m for m in ("encode", "submit", "flush", "flush_pipeline", "close") if hasattr(NvencEncoder, m)]
print("  pdum.nvenc OK — methods:", present)
PY
echo "Done. (If you use 'uv run', it targets ./.venv, so it now sees the new build.)"
