#!/usr/bin/env uv run python3
"""Release automation script for rfb.

This script automates the release process:
1. Verifies git repo is clean
2. Validates version has -alpha suffix
3. Calculates release version (strips -alpha)
4. Runs validation (lint, Python tests, widget tests, docs build)
5. Updates version files (pyproject.toml, __init__.py, widgets/package.json,
   packages/nvenc/pyproject.toml) — all in lockstep
6. Updates uv.lock with new version
7. Creates release commit and tag
8. Pushes tag to origin
9. Publishes both Python packages to PyPI (habemus-papadum-rfb + -nvenc, via publish.sh)
10. Builds and publishes the widgets to npm (@habemus-papadum/rfb-widgets)
11. Creates GitHub release (triggers docs deployment)
12. Bumps to next development version with -alpha
13. Updates uv.lock with new dev version
14. Commits and pushes development version
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable

from InquirerPy import inquirer
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.prompt import Prompt
from rich.table import Table

# Initialize Rich console
console = Console()

# File paths
REPO_ROOT = Path(__file__).parent.parent  # Go up from scripts/ to repo root
PYPROJECT_TOML = REPO_ROOT / "pyproject.toml"
INIT_PY = REPO_ROOT / "src" / "pdum" / "rfb" / "__init__.py"
WIDGETS_DIR = REPO_ROOT / "widgets"
PACKAGE_JSON = WIDGETS_DIR / "package.json"
# Sibling workspace package habemus-papadum-nvenc (import pdum.nvenc); released in
# lockstep with the rfb package, so its version is bumped alongside the others.
NVENC_PYPROJECT = REPO_ROOT / "packages" / "nvenc" / "pyproject.toml"

class StepCategory(Enum):
    """Categories of release steps."""

    VALIDATION = "Validation"
    PRE_RELEASE = "Pre-Release"
    RELEASE = "Release"
    POST_RELEASE = "Post-Release"


@dataclass
class Step:
    """Represents a single step in the release process."""

    id: str
    name: str
    description: str
    category: StepCategory
    action: Callable[[], None]
    notes: str | None = None
    enabled: bool = True


class ReleaseContext:
    """Shared context for the release process."""

    def __init__(self, bump_level: str):
        self.bump_level = bump_level
        self.current_version: str = ""
        self.release_version: str = ""
        self.next_dev_version: str = ""
        self.testing: bool = False


# Global context
ctx = ReleaseContext("")


def run_command(
    cmd: list[str], description: str, capture_output: bool = False
) -> subprocess.CompletedProcess:
    """Run a command and check for errors.

    Args:
        cmd: Command and arguments as list
        description: Human-readable description of what the command does
        capture_output: Whether to capture stdout/stderr

    Returns:
        CompletedProcess instance

    Raises:
        SystemExit: If command fails
    """
    console.print(f"[dim]→ Running:[/dim] {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, cwd=REPO_ROOT, capture_output=capture_output, text=True, check=True
        )
        if not capture_output:
            console.print(f"[green]✓[/green] {description}")
        return result
    except subprocess.CalledProcessError as e:
        console.print(f"[red]✗ ERROR:[/red] {description} failed!")
        if capture_output:
            if e.stdout:
                console.print(f"[dim]stdout:[/dim] {e.stdout}")
            if e.stderr:
                console.print(f"[dim]stderr:[/dim] {e.stderr}")
        sys.exit(1)


# ============================================================================
# STEP IMPLEMENTATIONS
# ============================================================================


def check_git_clean() -> None:
    """Verify that the git repository has no uncommitted changes."""
    console.rule("[bold blue]Checking Git Repository Status")

    result = run_command(
        ["git", "status", "--porcelain"],
        "Checking for uncommitted changes",
        capture_output=True,
    )

    if result.stdout.strip():
        console.print("[red]✗ ERROR:[/red] Git repository is not clean!")
        console.print("\n[yellow]Uncommitted changes:[/yellow]")
        console.print(result.stdout)
        sys.exit(1)

    console.print("[green]✓[/green] Git repository is clean")


def load_local_env() -> None:
    """Load REPO_ROOT/.env (git-ignored) into the environment.

    Mirrors scripts/publish.sh so the whole release flow is non-interactive:
    ``HATCH_INDEX_USER``/``HATCH_INDEX_AUTH`` (+ ``UV_PUBLISH_TOKEN``) authenticate
    PyPI publishing, and ``NPM_TOKEN`` (consumed by .npmrc) authenticates npm. Any
    variable already set in the environment takes precedence; missing .env is fine.
    """
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    loaded = []
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()
            loaded.append(key)
    if loaded:
        console.print(f"[dim]Loaded {len(loaded)} credential(s) from .env[/dim]")


def read_version_from_file(file_path: Path, pattern: str) -> str:
    """Read version from a file using a regex pattern."""
    content = file_path.read_text()
    match = re.search(pattern, content, flags=re.MULTILINE)

    if not match:
        console.print(f"[red]✗ ERROR:[/red] Could not find version in {file_path}")
        sys.exit(1)

    return match.group(2)


def write_version_to_file(file_path: Path, pattern: str, new_version: str) -> None:
    """Write new version to a file using a regex pattern."""
    content = file_path.read_text()
    new_content = re.sub(pattern, rf"\g<1>{new_version}\g<3>", content, flags=re.MULTILINE)
    file_path.write_text(new_content)


def read_package_json_version(file_path: Path) -> str:
    """Read version from package.json."""
    import json
    data = json.loads(file_path.read_text())
    return data.get("version", "")


def write_package_json_version(file_path: Path, new_version: str) -> None:
    """Write new version to package.json."""
    import json
    data = json.loads(file_path.read_text())
    data["version"] = new_version
    file_path.write_text(json.dumps(data, indent=2) + "\n")


def read_current_version() -> None:
    """Read current version from version-controlled files."""
    console.rule("[bold blue]Reading Current Version")

    pyproject_version = read_version_from_file(PYPROJECT_TOML, r'^(version = ")([^"]+)(")')
    console.print(f"  [cyan]pyproject.toml:[/cyan] {pyproject_version}")

    init_version = read_version_from_file(INIT_PY, r'(__version__ = ")([^"]+)(")')
    console.print(f"  [cyan]__init__.py:[/cyan] {init_version}")

    package_json_version = read_package_json_version(PACKAGE_JSON)
    console.print(f"  [cyan]widgets/package.json:[/cyan] {package_json_version}")

    nvenc_version = read_version_from_file(NVENC_PYPROJECT, r'^(version = ")([^"]+)(")')
    console.print(f"  [cyan]packages/nvenc/pyproject.toml:[/cyan] {nvenc_version}")

    if not (pyproject_version == init_version == package_json_version == nvenc_version):
        console.print("[red]✗ ERROR:[/red] Version mismatch!")
        console.print(f"  [yellow]pyproject.toml:[/yellow] {pyproject_version}")
        console.print(f"  [yellow]__init__.py:[/yellow] {init_version}")
        console.print(f"  [yellow]widgets/package.json:[/yellow] {package_json_version}")
        console.print(f"  [yellow]packages/nvenc/pyproject.toml:[/yellow] {nvenc_version}")
        sys.exit(1)

    ctx.current_version = pyproject_version
    console.print(f"\n[green]✓[/green] Current version: [bold]{ctx.current_version}[/bold]")

def validate_alpha_version() -> None:
    """Validate that version ends with -alpha."""
    if not ctx.current_version:
        console.print("[red]✗ ERROR:[/red] Cannot validate version: current_version not set")
        console.print("[yellow]Hint:[/yellow] Make sure 'Read Current Version' step is selected")
        sys.exit(1)

    if not ctx.current_version.endswith("-alpha"):
        console.print("[red]✗ ERROR:[/red] Version must end with -alpha to release")
        console.print(f"  [yellow]Current version:[/yellow] {ctx.current_version}")
        console.print(f"  [yellow]Expected format:[/yellow] X.Y.Z-alpha")
        sys.exit(1)

    console.print("[green]✓[/green] Version has -alpha suffix")


def calculate_release_version() -> None:
    """Calculate release version by stripping -alpha."""
    if not ctx.current_version:
        console.print("[red]✗ ERROR:[/red] Cannot calculate release version: current_version not set")
        console.print("[yellow]Hint:[/yellow] Make sure 'Read Current Version' step is selected")
        sys.exit(1)

    ctx.release_version = ctx.current_version.replace("-alpha", "")
    console.rule(f"[bold magenta]Preparing Release: {ctx.release_version}")
    console.print(f"  [cyan]Release version:[/cyan] [bold]{ctx.release_version}[/bold]")


def run_tests() -> None:
    """Run unit tests."""
    console.rule("[bold blue]Running Unit Tests")
    run_command(["uv", "run", "pytest"], "Running pytest")


def run_linting() -> None:
    """Run linting checks."""
    console.rule("[bold blue]Running Linting Checks")
    run_command(["uv", "run", "ruff", "check", "."], "Running ruff linting")


def build_docs() -> None:
    """Build documentation with mkdocs."""
    console.rule("[bold blue]Building Documentation")
    run_command(["uv", "run", "mkdocs", "build"], "Building mkdocs site")


def run_widget_tests() -> None:
    """Type-check and run the widget (TypeScript) test suite."""
    console.rule("[bold blue]Running Widget Tests")
    run_command(
        ["pnpm", "--dir", "widgets", "install", "--frozen-lockfile"],
        "Installing widget dependencies",
    )
    run_command(["pnpm", "--dir", "widgets", "typecheck"], "Type-checking widgets")
    run_command(["pnpm", "--dir", "widgets", "test"], "Running Vitest suite")




def update_version_files() -> None:
    """Update version in tracked files."""
    if not ctx.release_version:
        console.print("[red]✗ ERROR:[/red] Cannot update version files: release_version not set")
        console.print("[yellow]Hint:[/yellow] Make sure 'Calculate Release Version' step is selected")
        sys.exit(1)

    write_version_to_file(PYPROJECT_TOML, r'^(version = ")([^"]+)(")', ctx.release_version)
    write_version_to_file(INIT_PY, r'(__version__ = ")([^"]+)(")', ctx.release_version)
    write_package_json_version(PACKAGE_JSON, ctx.release_version)
    write_version_to_file(NVENC_PYPROJECT, r'^(version = ")([^"]+)(")', ctx.release_version)
    console.print(
        f"[green]✓[/green] Updated version to [bold]{ctx.release_version}[/bold] in all files"
    )


def update_lockfile() -> None:
    """Update uv.lock to reflect version changes in pyproject.toml."""
    console.rule("[bold blue]Updating Lockfile")
    run_command(["uv", "lock"], "Updating uv.lock with new version")


def create_release_commit() -> None:
    """Create a git commit for the release."""
    console.rule(f"[bold blue]Creating Release Commit: {ctx.release_version}")

    run_command(
        [
            "git",
            "add",
            str(PYPROJECT_TOML),
            str(INIT_PY),
            str(PACKAGE_JSON),
            str(NVENC_PYPROJECT),
            "uv.lock",
        ],
        "Staging version files and lockfile",
    )

    run_command(
        ["git", "commit", "-m", ctx.release_version], f"Committing release {ctx.release_version}"
    )


def create_release_tag() -> None:
    """Create an annotated git tag for the release."""
    tag_name = f"v{ctx.release_version}"
    console.rule(f"[bold blue]Creating Release Tag: {tag_name}")

    run_command(
        ["git", "tag", "-a", tag_name, "-m", ctx.release_version], f"Creating tag {tag_name}"
    )


def push_tag() -> None:
    """Push the release tag to origin."""
    tag_name = f"v{ctx.release_version}"
    console.rule(f"[bold blue]Pushing Tag to Origin: {tag_name}")

    run_command(["git", "push", "origin", tag_name], f"Pushing tag {tag_name}")


def publish_to_pypi() -> None:
    """Publish BOTH Python packages to PyPI via scripts/publish.sh.

    publish.sh builds + publishes habemus-papadum-rfb (hatch) and the native
    habemus-papadum-nvenc wheels, and loads .env for credentials. Set SKIP_NVENC=1
    to publish only rfb.
    """
    console.rule("[bold blue]Publishing to PyPI (rfb + nvenc)")

    run_command(["./scripts/publish.sh"], "Running publish.sh (habemus-papadum-rfb + habemus-papadum-nvenc)")


def publish_to_npm() -> None:
    """Build the widget bundle and publish it to npm.

    Builds first so the published `dist/` always reflects the release version —
    `pnpm publish` does not run the `build` script automatically.

    Auth: the npm token lives only in ``.env`` (as ``NPM_TOKEN``); there is no
    committed or persistent ``.npmrc`` (pnpm 11 refuses to expand ``${NPM_TOKEN}``
    from a project-level ``.npmrc``, and we keep dev environments auth-config-free).
    So we materialize the resolved token into a transient, 0600 npmrc outside the
    repo and point pnpm at it via ``NPM_CONFIG_USERCONFIG`` for the publish call only.
    """
    console.rule("[bold blue]Publishing Widgets to npm")

    run_command(
        ["pnpm", "--dir", "widgets", "install", "--frozen-lockfile"],
        "Installing widget dependencies",
    )
    run_command(["pnpm", "--dir", "widgets", "build"], "Building widget bundle")

    token = os.environ.get("NPM_TOKEN")
    if not token:
        console.print("[red]NPM_TOKEN is not set (add it to .env). Cannot authenticate the npm publish.[/red]")
        sys.exit(1)

    fd, npmrc_path = tempfile.mkstemp(prefix="pdum-npm-", suffix=".npmrc")  # mkstemp -> mode 0600
    try:
        os.write(fd, f"//registry.npmjs.org/:_authToken={token}\n".encode())
        os.close(fd)
        prev = os.environ.get("NPM_CONFIG_USERCONFIG")
        os.environ["NPM_CONFIG_USERCONFIG"] = npmrc_path
        try:
            run_command(
                ["pnpm", "--dir", "widgets", "publish", "--no-git-checks"],
                "Publishing @habemus-papadum/rfb-widgets to npm",
            )
        finally:
            if prev is None:
                os.environ.pop("NPM_CONFIG_USERCONFIG", None)
            else:
                os.environ["NPM_CONFIG_USERCONFIG"] = prev
    finally:
        Path(npmrc_path).unlink(missing_ok=True)


def create_github_release() -> None:
    """Create a GitHub release for the version tag."""
    tag_name = f"v{ctx.release_version}"
    console.rule(f"[bold blue]Creating GitHub Release: {tag_name}")

    run_command(
        ["gh", "release", "create", tag_name, "--title", ctx.release_version, "--generate-notes"],
        f"Creating GitHub release {tag_name}",
    )


def bump_version(version: str, level: str) -> str:
    """Bump version according to level."""
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)$", version)
    if not match:
        console.print(f"[red]✗ ERROR:[/red] Invalid version format: {version}")
        sys.exit(1)

    major, minor, patch = map(int, match.groups())

    if level == "patch":
        patch += 1
    elif level == "minor":
        minor += 1
        patch = 0
    elif level == "major":
        major += 1
        minor = 0
        patch = 0
    else:
        console.print(f"[red]✗ ERROR:[/red] Invalid bump level: {level}")
        sys.exit(1)

    return f"{major}.{minor}.{patch}"


def calculate_next_dev_version() -> None:
    """Calculate next development version."""
    # If release_version wasn't calculated yet, derive it from current_version
    if not ctx.release_version:
        if not ctx.current_version:
            console.print("[red]✗ ERROR:[/red] Cannot calculate next dev version: current_version not set")
            console.print("[yellow]Hint:[/yellow] Make sure 'Read Current Version' step is selected")
            sys.exit(1)
        ctx.release_version = ctx.current_version.replace("-alpha", "")
        console.print(f"[dim]Derived release version: {ctx.release_version}[/dim]")

    next_version = bump_version(ctx.release_version, ctx.bump_level)
    ctx.next_dev_version = f"{next_version}-alpha"

    console.rule(f"[bold magenta]Preparing Next Development Version: {ctx.next_dev_version}")
    console.print(f"  [cyan]Next development version:[/cyan] [bold]{ctx.next_dev_version}[/bold]")


def update_to_dev_version() -> None:
    """Update version files to next development version."""
    if not ctx.next_dev_version:
        console.print("[red]✗ ERROR:[/red] Cannot update version files: next_dev_version not set")
        console.print("[yellow]Hint:[/yellow] Make sure 'Calculate Next Dev Version' step is selected")
        sys.exit(1)

    write_version_to_file(PYPROJECT_TOML, r'^(version = ")([^"]+)(")', ctx.next_dev_version)
    write_version_to_file(INIT_PY, r'(__version__ = ")([^"]+)(")', ctx.next_dev_version)
    write_package_json_version(PACKAGE_JSON, ctx.next_dev_version)
    write_version_to_file(NVENC_PYPROJECT, r'^(version = ")([^"]+)(")', ctx.next_dev_version)
    console.print(
        f"[green]✓[/green] Updated version to [bold]{ctx.next_dev_version}[/bold] in all files"
    )


def update_lockfile_dev() -> None:
    """Update uv.lock with dev version."""
    console.rule("[bold blue]Updating Lockfile (Dev Version)")
    run_command(["uv", "lock"], "Updating uv.lock with new dev version")


def create_dev_commit() -> None:
    """Create a git commit for the development version."""
    console.rule(f"[bold blue]Creating Development Version Commit: {ctx.next_dev_version}")

    run_command(
        [
            "git",
            "add",
            str(PYPROJECT_TOML),
            str(INIT_PY),
            str(PACKAGE_JSON),
            str(NVENC_PYPROJECT),
            "uv.lock",
        ],
        "Staging version files and lockfile",
    )

    run_command(
        ["git", "commit", "-m", f"Bump to {ctx.next_dev_version}"],
        f"Committing development version {ctx.next_dev_version}",
    )


def push_dev_commit() -> None:
    """Push the development version commit to origin."""
    console.rule("[bold blue]Pushing Development Commit to Origin")

    result = run_command(
        ["git", "branch", "--show-current"], "Getting current branch name", capture_output=True
    )
    branch = result.stdout.strip()

    run_command(["git", "push", "origin", branch], f"Pushing to origin/{branch}")


# ============================================================================
# STEP REGISTRY
# ============================================================================

STEPS: list[Step] = [
    # Validation steps
    Step(
        id="check_git_clean",
        name="Check Git Status",
        description="Verify repository has no uncommitted changes",
        category=StepCategory.VALIDATION,
        action=check_git_clean,
    ),
    Step(
        id="read_version",
        name="Read Current Version",
        description="Read version from pyproject.toml and __init__.py",
        category=StepCategory.VALIDATION,
        action=read_current_version,
    ),
    Step(
        id="validate_alpha",
        name="Validate Alpha Version",
        description="Ensure version has -alpha suffix",
        category=StepCategory.VALIDATION,
        action=validate_alpha_version,
    ),
    Step(
        id="calculate_release",
        name="Calculate Release Version",
        description="Strip -alpha suffix to get release version",
        category=StepCategory.VALIDATION,
        action=calculate_release_version,
    ),
    # Python processing (lint, test, build docs)
    Step(
        id="run_linting",
        name="Run Linting",
        description="Check code quality with ruff",
        category=StepCategory.VALIDATION,
        action=run_linting,
        notes="Usually fast (< 10s)",
    ),
    Step(
        id="run_tests",
        name="Run Unit Tests",
        description="Execute pytest test suite",
        category=StepCategory.VALIDATION,
        action=run_tests,
        notes="Usually fast (< 30s)",
    ),
    Step(
        id="run_widget_tests",
        name="Run Widget Tests",
        description="Type-check and run the widget (Vitest) test suite",
        category=StepCategory.VALIDATION,
        action=run_widget_tests,
        notes="Requires pnpm",
    ),
    Step(
        id="build_docs",
        name="Build Documentation",
        description="Build mkdocs site",
        category=StepCategory.VALIDATION,
        action=build_docs,
        notes="Moderate speed (30-60s)",
    ),
    # Pre-release steps
    Step(
        id="update_version",
        name="Update Version Files",
        description="Update version to release version in pyproject.toml and __init__.py",
        category=StepCategory.PRE_RELEASE,
        action=update_version_files,
    ),
    Step(
        id="update_lockfile",
        name="Update Lockfile",
        description="Update uv.lock with release version",
        category=StepCategory.PRE_RELEASE,
        action=update_lockfile,
    ),
    Step(
        id="create_commit",
        name="Create Release Commit",
        description="Create git commit for release",
        category=StepCategory.PRE_RELEASE,
        action=create_release_commit,
    ),
    Step(
        id="create_tag",
        name="Create Release Tag",
        description="Create annotated git tag for release",
        category=StepCategory.PRE_RELEASE,
        action=create_release_tag,
    ),
    # Release steps
    Step(
        id="push_tag",
        name="Push Tag",
        description="Push release tag to origin",
        category=StepCategory.RELEASE,
        action=push_tag,
    ),
    Step(
        id="publish_pypi",
        name="Publish to PyPI",
        description="Build + publish both Python packages (habemus-papadum-rfb + -nvenc)",
        category=StepCategory.RELEASE,
        action=publish_to_pypi,
        notes="nvenc build needs a CUDA toolkit; SKIP_NVENC=1 for rfb only",
    ),
    Step(
        id="publish_npm",
        name="Publish to npm",
        description="Build the widget bundle and publish @habemus-papadum/rfb-widgets to npm",
        category=StepCategory.RELEASE,
        action=publish_to_npm,
        notes="Requires pnpm + NPM_TOKEN (in .env, consumed by .npmrc)",
    ),
    Step(
        id="github_release",
        name="Create GitHub Release",
        description="Create GitHub release (triggers docs deployment)",
        category=StepCategory.RELEASE,
        action=create_github_release,
    ),
    # Post-release steps
    Step(
        id="calc_next_dev",
        name="Calculate Next Dev Version",
        description="Bump version and add -alpha suffix",
        category=StepCategory.POST_RELEASE,
        action=calculate_next_dev_version,
    ),
    Step(
        id="update_dev_version",
        name="Update to Dev Version",
        description="Update version files to next dev version",
        category=StepCategory.POST_RELEASE,
        action=update_to_dev_version,
    ),
    Step(
        id="update_lockfile_dev",
        name="Update Lockfile (Dev)",
        description="Update uv.lock with dev version",
        category=StepCategory.POST_RELEASE,
        action=update_lockfile_dev,
    ),
    Step(
        id="create_dev_commit",
        name="Create Dev Commit",
        description="Create git commit for dev version",
        category=StepCategory.POST_RELEASE,
        action=create_dev_commit,
    ),
    Step(
        id="push_dev_commit",
        name="Push Dev Commit",
        description="Push dev version commit to origin",
        category=StepCategory.POST_RELEASE,
        action=push_dev_commit,
    ),
]


def show_step_selector() -> list[Step]:
    """Show interactive step selector and return selected steps."""
    console.print()

    # Create choices for InquirerPy
    choices = []
    for step in STEPS:
        # Format: "Category | Name - Description"
        display = f"[{step.category.value}] {step.name}: {step.description}"
        if step.notes:
            display += f" ({step.notes})"
        choices.append({"name": display, "value": step.id, "enabled": step.enabled})

    # Show multi-select checkbox prompt
    selected_ids = inquirer.checkbox(
        message="Select steps to execute (use spacebar to toggle, enter to confirm):",
        choices=choices,
        instruction="(Use arrow keys to move, space to toggle, enter to confirm)",
    ).execute()

    # Return selected steps
    return [step for step in STEPS if step.id in selected_ids]


def show_acknowledgment_guard(bump_level: str) -> bool:
    """Show acknowledgment guard and return whether to proceed."""
    if getattr(ctx, "testing", False):
        return True
    panel = Panel.fit(
        "[bold red]⚠️  WARNING: This script will perform a RELEASE ⚠️[/bold red]\n\n"
        "This script will:\n"
        "  • Run all selected validation checks\n"
        "  • Create and push a release commit and tag\n"
        "  • Publish the package to PyPI\n"
        "  • Publish the widgets to npm\n"
        "  • Create a GitHub release (triggering docs deployment)\n"
        "  • Bump to the next development version\n\n"
        "[bold yellow]This is a SERIOUS operation that affects production![/bold yellow]",
        title="[bold]Release Confirmation[/bold]",
        border_style="red",
    )
    console.print(panel)
    console.print()

    response = Prompt.ask(
        "[bold]Type 'acknowledge' to continue or anything else to cancel[/bold]"
    )

    return response.strip() == "acknowledge"


def main() -> None:
    """Main release workflow."""
    # Parse arguments
    parser = argparse.ArgumentParser(description="Automate the release process for rfb")
    parser.add_argument(
        "bump_level",
        choices=["patch", "minor", "major"],
        help="Version bump level for next development version",
    )
    parser.add_argument(
        "--testing",
        action="store_true",
        help="Testing/dry-run mode that skips any operations pushing to git remotes or publishing releases",
    )
    args = parser.parse_args()

    # Set global context
    ctx.bump_level = args.bump_level
    ctx.testing = args.testing

    # Load local PyPI + npm credentials (.env) so publishing is non-interactive.
    load_local_env()

    # Show title
    title = Panel.fit(
        "[bold cyan]rfb Release Script[/bold cyan]\n\n"
        f"Bump level: [yellow]{args.bump_level}[/yellow]",
        border_style="cyan",
    )
    console.print(title)

    if ctx.testing:
        console.print("[yellow]Testing mode enabled: skipping interactive release flow and all remote/publish actions.[/yellow]")
        console.print("[green]✓[/green] No release steps were executed.")
        sys.exit(0)

    # Show acknowledgment guard
    if not show_acknowledgment_guard(args.bump_level):
        console.print("\n[red]✗[/red] Release cancelled. You must type 'acknowledge' to proceed.")
        sys.exit(1)

    console.print("[green]✓[/green] Proceeding with release...\n")

    # Show step selector
    selected_steps = show_step_selector()

    if not selected_steps:
        console.print("\n[yellow]No steps selected. Exiting.[/yellow]")
        sys.exit(0)

    # Show summary
    console.print(f"\n[bold]Selected {len(selected_steps)} steps:[/bold]")
    for i, step in enumerate(selected_steps, 1):
        console.print(f"  {i}. [{step.category.value}] {step.name}")

    console.print()
    confirm_execute = Prompt.ask("[bold]Execute selected steps?[/bold]", choices=["y", "n"])

    if confirm_execute != "y":
        console.print("\n[yellow]Cancelled.[/yellow]")
        sys.exit(0)

    # Execute selected steps
    console.print("\n" + "=" * 70)
    console.print("[bold green]Starting Release Process[/bold green]")
    console.print("=" * 70 + "\n")

    for i, step in enumerate(selected_steps, 1):
        console.print(f"\n[bold cyan]Step {i}/{len(selected_steps)}:[/bold cyan] {step.name}")
        try:
            step.action()
        except Exception as e:
            console.print(f"\n[red]✗ ERROR in step '{step.name}':[/red] {e}")
            sys.exit(1)

    # Success!
    console.print()
    success_panel = Panel.fit(
        f"[bold green]✓ Release Complete![/bold green]\n\n"
        f"Released: [cyan]{ctx.release_version}[/cyan]\n"
        f"Tagged and pushed: [cyan]v{ctx.release_version}[/cyan]\n"
        f"Published to PyPI: [cyan]{ctx.release_version}[/cyan]\n"
        f"Published to npm: [cyan]@habemus-papadum/rfb-widgets@{ctx.release_version}[/cyan]\n"
        f"Created GitHub release: [cyan]v{ctx.release_version}[/cyan]\n"
        f"Next development version: [cyan]{ctx.next_dev_version}[/cyan]\n\n"
        "[dim]The GitHub release will trigger documentation deployment to GitHub Pages.[/dim]",
        title="[bold]Success[/bold]",
        border_style="green",
    )
    console.print(success_panel)


if __name__ == "__main__":
    main()
