#!/usr/bin/env bash

# Setup script for rfb development environment

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."

cd "$REPO_ROOT"

echo "============================================="
echo "Setting up rfb"
echo "============================================="
echo ""

check_command() {
    local cmd=$1
    local install_url=$2
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "❌ Error: $cmd is not installed"
        echo "   Install it from: $install_url"
        exit 1
    fi
    echo "   ✓ $cmd found: $($cmd --version | head -n 1)"
}

echo "1. Checking prerequisites..."
check_command uv "https://docs.astral.sh/uv/getting-started/installation/"

echo ""
echo "2. Installing Python dependencies..."

# Auto-detect the GPU backend. The native SDK encoder (habemus-papadum-nvenc ->
# pdum.nvenc, the gpu-nvenc-sdk extra) is built/installed editable only on a
# Linux box that has both an NVIDIA GPU and a CUDA toolkit to compile it. mac /
# no-GPU / no-toolkit boxes fall through to the plain CPU sync untouched.
#   RFB_GPU=auto   (default) build the GPU extra iff the box can support it
#   RFB_GPU=force            build it even if detection is unsure (CUDA major != 13)
#   RFB_GPU=0|off|no         never build it
RFB_GPU="${RFB_GPU:-auto}"

gpu_capable() {
    [ "$(uname -s)" = "Linux" ] || return 1
    command -v nvidia-smi >/dev/null 2>&1 || return 1
    nvidia-smi -L >/dev/null 2>&1 || return 1   # a GPU is actually visible
    command -v nvcc >/dev/null 2>&1 || return 1 # CUDA toolkit to compile against
    return 0
}
cuda_major() { nvcc --version 2>/dev/null | sed -n 's/.*release \([0-9][0-9]*\)\..*/\1/p' | head -n1; }

EXTRA_ARGS=()
case "$RFB_GPU" in
    0 | off | false | no)
        echo "   GPU extra disabled (RFB_GPU=$RFB_GPU); installing CPU paths only"
        ;;
    force)
        echo "   GPU extra forced (RFB_GPU=force); will build pdum.nvenc"
        EXTRA_ARGS=(--extra gpu-nvenc-sdk)
        ;;
    *) # auto (and any unknown value)
        if gpu_capable; then
            major="$(cuda_major)"
            if [ -n "$major" ] && [ "$major" != "13" ]; then
                echo "   ⚠ NVIDIA GPU found but CUDA toolkit is ${major}.x; the gpu-nvenc-sdk extra"
                echo "     pins cupy-cuda13x. Skipping auto-build. To build anyway, swap to"
                echo "     cupy-cuda12x and run: uv sync --frozen --extra gpu-nvenc-sdk (or RFB_GPU=force)"
            else
                echo "   Linux + NVIDIA GPU + CUDA ${major:-?} detected -> building pdum.nvenc (editable)"
                EXTRA_ARGS=(--extra gpu-nvenc-sdk)
            fi
        else
            echo "   No Linux+NVIDIA+CUDA toolkit detected; installing CPU paths only"
            echo "   (GPU backends stay dormant and are runtime-probed; nothing breaks)"
        fi
        ;;
esac

# Auto-detect the macOS VideoToolbox backend. The native encoder (habemus-papadum-vtenc
# -> pdum.vtenc, the mac-vt extra) builds on any Apple-Silicon Mac with the Xcode
# Command Line Tools (clang + system frameworks); the mac-dev group adds MLX so the
# end-to-end example/tests run. Non-mac / Intel / no-CLT boxes fall through untouched.
#   RFB_VT=auto (default) build it iff Apple-Silicon + clang are present
#   RFB_VT=force          build it regardless
#   RFB_VT=0|off|no       never build it
RFB_VT="${RFB_VT:-auto}"
vt_capable() {
    [ "$(uname -s)" = "Darwin" ] || return 1
    [ "$(uname -m)" = "arm64" ] || return 1
    command -v clang >/dev/null 2>&1 || return 1  # Xcode CLT to compile the .mm
    return 0
}
case "$RFB_VT" in
    0 | off | false | no)
        echo "   VideoToolbox extra disabled (RFB_VT=$RFB_VT)"
        ;;
    force)
        echo "   VideoToolbox extra forced (RFB_VT=force); will build pdum.vtenc"
        EXTRA_ARGS+=(--extra mac-vt --group mac-dev)
        ;;
    *) # auto
        if vt_capable; then
            echo "   Apple Silicon + Xcode CLT detected -> building pdum.vtenc (editable) + MLX"
            EXTRA_ARGS+=(--extra mac-vt --group mac-dev)
        fi
        ;;
esac

if ! uv sync --frozen ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}; then
    if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
        echo "   ⚠ GPU extra sync failed; retrying base-only so you still have a working env."
        echo "     Build prereqs/troubleshooting: packages/nvenc/build-wheel.sh, docs/proposals/completed/nvenc_sdk_evaluation.md"
        uv sync --frozen
    else
        exit 1
    fi
fi

echo ""
echo "3. Installing widget (TypeScript) dependencies..."
# Node.js and pnpm are NOT provided by this script — we only detect them and tell
# you how to install them if missing, then skip the browser client gracefully so a
# Python-only box still ends up with a working env.
NODE_MIN=20   # widgets/ (Vite 6 / Vitest 3) needs Node >= 20; .nvmrc pins the LTS we test on
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ -d "widgets" ]; then
    if ! command -v node >/dev/null 2>&1; then
        echo "   ⚠ Node.js not found; skipping the browser client."
        echo "     Install Node.js ${NODE_MIN}+ (https://nodejs.org/), then re-run this script."
    elif [ "$(node_major)" -lt "$NODE_MIN" ]; then
        echo "   ⚠ Node.js $(node --version) is too old; the browser client needs Node ${NODE_MIN}+."
        echo "     Upgrade with nvm/fnm ('nvm install 22'), pnpm ('pnpm env use --global 22'),"
        echo "     or your OS packages, then re-run. (.nvmrc pins the version CI uses.)"
    elif ! command -v pnpm >/dev/null 2>&1; then
        echo "   ⚠ pnpm not found; skipping the browser client."
        echo "     Enable it with 'corepack enable' (ships with Node) or 'npm i -g pnpm', then re-run."
    else
        echo "   ✓ node $(node --version) (≥${NODE_MIN}), pnpm $(pnpm --version)"
        (cd widgets && pnpm install --frozen-lockfile)

        # Rebuild the committed anywidget bundle (src/pdum/rfb/static/widget.{js,css}) so a
        # dev tree / the notebook test always has it in sync with the TS source.
        echo "   Building the anywidget bundle..."
        (cd widgets && pnpm run build:anywidget) || echo "   ⚠ anywidget bundle build failed"

        # Playwright's Chromium is required for the e2e tests (pnpm -C widgets e2e).
        # The download is idempotent (skipped if already present); it needs no sudo.
        echo "   Installing Playwright Chromium (for e2e tests)..."
        if (cd widgets && pnpm exec playwright install chromium); then
            echo "   ✓ Chromium ready"
        else
            echo "   ⚠ Chromium install failed; e2e tests stay unavailable. Retry with:"
            echo "     pnpm -C widgets exec playwright install --with-deps chromium"
            echo "     ('--with-deps' pulls system libs on Linux and needs sudo)."
        fi
    fi
else
    echo "   Skipping (no widgets/ directory)"
fi

if [ -f ".pre-commit-config.yaml" ]; then
    echo ""
    echo "4. Installing pre-commit hooks..."
    uv run pre-commit install || true
else
    echo ""
    echo "4. Skipping pre-commit hook installation (no .pre-commit-config.yaml)"
fi

echo ""
echo "============================================="
echo "✅ Setup complete!"
echo "============================================="
