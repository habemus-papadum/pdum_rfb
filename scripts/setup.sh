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
uv sync --frozen

echo ""
echo "3. Installing widget (TypeScript) dependencies..."
if [ -d "widgets" ]; then
    if command -v corepack >/dev/null 2>&1; then
        corepack enable >/dev/null 2>&1 || true
    fi
    if command -v pnpm >/dev/null 2>&1; then
        (cd widgets && pnpm install --frozen-lockfile)
    else
        echo "   ⚠ pnpm not found; skipping widget install (Node.js + pnpm needed for the browser client)"
    fi
else
    echo "   Skipping (no widgets/ directory)"
fi

if [ -f ".pre-commit-config.yaml" ]; then
    echo ""
    echo "5. Installing pre-commit hooks..."
    uv run pre-commit install || true
else
    echo ""
    echo "5. Skipping pre-commit hook installation (no .pre-commit-config.yaml)"
fi

echo ""
echo "============================================="
echo "✅ Setup complete!"
echo "============================================="
