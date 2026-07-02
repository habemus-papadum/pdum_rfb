#!/usr/bin/env uv run python3
"""Return the repo to development after a release is published.

The closing half of the hybrid release flow: once ``prepare-release.sh`` + CI have shipped
``vX.Y.Z``, this bumps every version file to the next ``-alpha`` (per ``bump_level``), repins the
native extras, relocks, commits, and pushes ``main``.

    ./scripts/post-release.sh patch     # after releasing 0.3.0 -> dev 0.3.1-alpha
    ./scripts/post-release.sh minor     # -> dev 0.4.0-alpha

Idempotent-ish: safe to re-run if the push failed. NEVER run from CI.
"""

from __future__ import annotations

import argparse
import subprocess
import sys

import _versioning as V

C = {"g": "\033[32m", "r": "\033[31m", "y": "\033[33m", "b": "\033[1;34m", "d": "\033[2m", "x": "\033[0m"}


def say(msg: str, color: str = "x") -> None:
    print(f"{C[color]}{msg}{C['x']}")


def die(msg: str) -> None:
    say(f"✗ {msg}", "r")
    sys.exit(1)


def run(cmd: list[str], desc: str) -> None:
    say(f"→ {desc}", "d")
    if subprocess.run(cmd, cwd=V.REPO_ROOT).returncode != 0:
        die(f"{desc} failed")


def capture(cmd: list[str]) -> str:
    return subprocess.run(cmd, cwd=V.REPO_ROOT, capture_output=True, text=True).stdout.strip()


def confirm(prompt: str) -> bool:
    return input(f"{C['y']}{prompt} [y/N] {C['x']}").strip().lower() == "y"


def main() -> None:
    ap = argparse.ArgumentParser(description="Bump to the next -alpha dev version after a release.")
    ap.add_argument("bump_level", choices=["patch", "minor", "major"])
    ap.add_argument("--no-push", action="store_true", help="commit but don't push main")
    args = ap.parse_args()

    if capture(["git", "status", "--porcelain"]):
        die("git working tree is not clean — commit or stash first")

    current = V.read_current_version()
    if current.endswith("-alpha"):
        die(f"already at a dev version ({current}); run this only after a release (a clean X.Y.Z)")
    next_dev = f"{V.bump_version(current, args.bump_level)}-alpha"
    say(f"{C['b']}Post-release {current} → {next_dev}{C['x']}")

    V.set_version(next_dev)
    run(["uv", "lock"], "uv lock")

    files = [str(vf.path) for vf in V.discover_version_files()] + ["pyproject.toml", "uv.lock"]
    run(["git", "add", *files], "stage version files")
    run(["git", "commit", "-m", f"Bump to {next_dev}"], f"commit {next_dev}")

    branch = capture(["git", "branch", "--show-current"])
    if args.no_push:
        say(f"\n✓ committed {next_dev} on {branch} (not pushed). Push:  git push origin {branch}", "g")
    elif confirm(f"\nPush the dev-version commit to origin/{branch}?"):
        run(["git", "push", "origin", branch], f"push {branch}")
        say(f"\n✓ back on {next_dev} — released and reset for development.", "g")
    else:
        say(f"\n✓ committed {next_dev} on {branch} (not pushed). Push:  git push origin {branch}", "g")


if __name__ == "__main__":
    main()
