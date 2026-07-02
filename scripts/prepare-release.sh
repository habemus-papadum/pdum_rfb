#!/usr/bin/env uv run python3
"""Cut a release *locally*, then hand off publishing to CI.

The local half of the hybrid release flow (docs/development.md): validate, strip ``-alpha``,
bump every version file + repin the native extras in lockstep, commit, tag ``vX.Y.Z``, and push
the tag. **Pushing the tag is what triggers ``.github/workflows/release.yml``** to build the
wheel matrix and publish to PyPI (trusted publishing) + npm (provenance). No tokens are used
here and nothing is published from this box.

    ./scripts/prepare-release.sh patch          # 0.3.0-alpha -> release 0.3.0
    ./scripts/prepare-release.sh minor --skip-validation

``bump_level`` (patch/minor/major) is only used later by ``post-release.sh`` for the *next* dev
version; it's accepted here so the whole release is one consistent invocation. After CI is green,
run ``./scripts/post-release.sh <bump_level>``.

Recovery if CI fails: see docs/release_recovery.md (re-push the same tag; publishing is
idempotent via skip-existing). NEVER run this from CI.
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
    ap = argparse.ArgumentParser(description="Cut a release locally; CI publishes on the pushed tag.")
    ap.add_argument("bump_level", choices=["patch", "minor", "major"])
    ap.add_argument("--skip-validation", action="store_true", help="skip lint/test/docs (e.g. pre-release.sh already ran)")
    ap.add_argument("--no-push", action="store_true", help="commit + tag but don't push the tag (no CI trigger)")
    args = ap.parse_args()

    # 1. Clean tree.
    if capture(["git", "status", "--porcelain"]):
        die("git working tree is not clean — commit or stash first")
    say("✓ git tree clean", "g")

    # 2. Read + validate the current version, compute the release version.
    try:
        current = V.read_current_version()
        release = V.strip_alpha(current)
    except V.VersionError as e:
        die(str(e))
    say(f"\n{C['b']}Release {current} → {release}{C['x']}")

    # 3. Validate (matches pre-release.sh + the widget suite).
    if args.skip_validation:
        say("⚠ skipping validation (--skip-validation)", "y")
    else:
        run(["uv", "run", "ruff", "check", "."], "ruff")
        run(["uv", "run", "pytest"], "pytest")
        run(["pnpm", "--dir", "widgets", "install", "--frozen-lockfile"], "pnpm install")
        run(["pnpm", "--dir", "widgets", "typecheck"], "widget typecheck")
        run(["pnpm", "--dir", "widgets", "test"], "widget tests")
        run(["uv", "run", "mkdocs", "build"], "mkdocs build")

    # 4. Bump all version files + repin native extras, then relock.
    V.set_version(release)
    anchor = V._minor_series(release)
    say(f"✓ set version {release} in {len(V.discover_version_files())} files; extras pinned ~={anchor}", "g")
    run(["uv", "lock"], "uv lock")

    # 5. Commit + tag.
    files = [str(vf.path) for vf in V.discover_version_files()] + ["pyproject.toml", "uv.lock"]
    run(["git", "add", *files], "stage version files")
    run(["git", "commit", "-m", release], f"commit {release}")
    tag = f"v{release}"
    run(["git", "tag", "-a", tag, "-m", release], f"tag {tag}")

    # 6. Push the tag — this triggers the CI release. Gated behind a confirmation.
    if args.no_push:
        say(f"\n✓ committed + tagged {tag} locally (not pushed).", "g")
        say(f"  Push when ready:  git push origin {tag}   (triggers CI publish)", "d")
    elif confirm(f"\nPush {tag} to origin? This triggers CI to PUBLISH to PyPI + npm."):
        run(["git", "push", "origin", tag], f"push {tag}")
        say(f"\n✓ {tag} pushed — watch: gh run watch  (or the Actions tab)", "g")
    else:
        say(f"\n✓ committed + tagged {tag} locally (not pushed).", "g")
        say(f"  Push when ready:  git push origin {tag}", "d")

    say(f"\nAfter CI is green: ./scripts/post-release.sh {args.bump_level}   (bumps to the next -alpha)", "b")
    say("If CI fails: docs/release_recovery.md", "d")


if __name__ == "__main__":
    main()
