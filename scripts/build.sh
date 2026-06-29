#!/usr/bin/env bash

# Build script for rfb

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."

cd "$REPO_ROOT"

echo "============================================="
echo "Building rfb"
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
uv sync --frozen

echo ""
echo "3. Building TypeScript widgets..."
if [ -d "widgets" ] && command -v pnpm >/dev/null 2>&1; then
    (cd widgets && pnpm install --frozen-lockfile && pnpm build)
else
    echo "   (Skipped) widgets/ directory or pnpm not available"
fi

echo ""
echo "============================================="
echo "✅ Build complete!"
echo "============================================="
