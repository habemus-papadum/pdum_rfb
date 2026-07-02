"""Shared version logic for the release scripts (dependency-light: stdlib only).

The single source of truth for how ``pdum.rfb``'s **lockstep** version is discovered, read,
bumped, and written across all 10 version-bearing files, plus how rfb's native extras are
pinned to the shared minor. Imported by ``prepare-release.sh`` and ``post-release.sh``.

``scripts/release.sh`` (the legacy all-in-one, kept as a manual fallback) carries its own copy
of this logic on purpose — it must keep working untouched for the imminent 0.1.0 release. Once
the CI pipeline is the blessed path, release.sh can be retired in favour of prepare/post + CI and
this module becomes the only copy.

Versioning policy (see docs/development.md):
  * lockstep — every published package shares one version, agreement is enforced;
  * npm wrapper->core stays a ``^`` peer range (correct for peer deps);
  * rfb's Python native extras (gpu-nvenc-sdk->nvenc, mac-vt->vtenc) track the shared minor
    as ``~=X.Y.0`` so ``rfb X.Y.*`` pulls a matching native ``X.Y.*``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT_TOML = REPO_ROOT / "pyproject.toml"
INIT_PY = REPO_ROOT / "src" / "pdum" / "rfb" / "__init__.py"
WIDGETS_DIR = REPO_ROOT / "widgets"
PACKAGE_JSON = WIDGETS_DIR / "package.json"

_TOML_VERSION_RE = r'^(version = ")([^"]+)(")'
_INIT_VERSION_RE = r'(__version__ = ")([^"]+)(")'

#: rfb extras whose internal (workspace) native deps track the shared minor via ``~=``.
#: Self-referential extras (rfb[cli,...]) are intentionally excluded — pip resolves a
#: self-extra to the same distribution, so a version pin there is meaningless.
INTERNAL_EXTRA_DEPS = ("habemus-papadum-nvenc", "habemus-papadum-vtenc")


class VersionError(RuntimeError):
    """Raised on a malformed version or a lockstep disagreement across files."""


@dataclass(frozen=True)
class VersionFile:
    """A file whose version is bumped in lockstep with every release.

    ``kind`` selects the read/write strategy; ``ecosystem`` is where the package ships
    (``pypi``/``npm``, or ``python`` for the ``__init__.py`` mirror); ``published`` is False for
    the mirror or a ``"private": true`` npm package (version-synced but never uploaded).
    """

    path: Path
    kind: str  # "toml" | "init_py" | "package_json"
    name: str  # display / package name
    ecosystem: str  # "pypi" | "npm" | "python"
    published: bool


def _toml_name(path: Path) -> str:
    """Best-effort project name from a pyproject.toml (falls back to the dir name)."""
    match = re.search(r'^name = "([^"]+)"', path.read_text(), flags=re.MULTILINE)
    return match.group(1) if match else path.parent.name


def discover_version_files() -> list[VersionFile]:
    """Find every version-bearing file across the workspace, dynamically.

    PyPI: root pyproject + every ``packages/*/pyproject.toml`` (+ the ``__init__.py`` mirror).
    npm: the core ``widgets/package.json`` + every ``widgets/packages/*/package.json``
    (``"private": true`` ones are synced but not published). Adding a workspace member needs no
    edit here.
    """
    files: list[VersionFile] = [
        VersionFile(PYPROJECT_TOML, "toml", _toml_name(PYPROJECT_TOML), "pypi", True),
        VersionFile(INIT_PY, "init_py", "pdum.rfb.__version__", "python", False),
    ]
    for pyproject in sorted((REPO_ROOT / "packages").glob("*/pyproject.toml")):
        files.append(VersionFile(pyproject, "toml", _toml_name(pyproject), "pypi", True))
    for package_json in [PACKAGE_JSON, *sorted((WIDGETS_DIR / "packages").glob("*/package.json"))]:
        data = json.loads(package_json.read_text())
        name = data.get("name", package_json.parent.name)
        published = not bool(data.get("private", False))
        files.append(VersionFile(package_json, "package_json", name, "npm", published))
    return files


def _read_toml_like(path: Path, pattern: str) -> str:
    match = re.search(pattern, path.read_text(), flags=re.MULTILINE)
    if not match:
        raise VersionError(f"Could not find a version in {path}")
    return match.group(2)


def read_version_of(vf: VersionFile) -> str:
    """Read the current version out of a discovered file."""
    if vf.kind == "package_json":
        return json.loads(vf.path.read_text()).get("version", "")
    return _read_toml_like(vf.path, _INIT_VERSION_RE if vf.kind == "init_py" else _TOML_VERSION_RE)


def write_version_of(vf: VersionFile, new_version: str) -> None:
    """Write a new version into a discovered file."""
    if vf.kind == "package_json":
        data = json.loads(vf.path.read_text())
        data["version"] = new_version
        vf.path.write_text(json.dumps(data, indent=2) + "\n")
        return
    pattern = _INIT_VERSION_RE if vf.kind == "init_py" else _TOML_VERSION_RE
    new_content = re.sub(pattern, rf"\g<1>{new_version}\g<3>", vf.path.read_text(), flags=re.MULTILINE)
    vf.path.write_text(new_content)


def read_current_version(files: list[VersionFile] | None = None) -> str:
    """Read the version from every file and require agreement (lockstep invariant)."""
    files = files or discover_version_files()
    versions = {vf: read_version_of(vf) for vf in files}
    unique = set(versions.values())
    if len(unique) != 1:
        lines = "\n".join(f"  {vf.path.relative_to(REPO_ROOT)}: {v}" for vf, v in versions.items())
        raise VersionError(f"Version mismatch across packages:\n{lines}")
    return next(iter(unique))


def bump_version(version: str, level: str) -> str:
    """Bump a plain ``X.Y.Z`` version by ``patch`` / ``minor`` / ``major``."""
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)$", version)
    if not match:
        raise VersionError(f"Invalid version format (need X.Y.Z): {version}")
    major, minor, patch = (int(g) for g in match.groups())
    if level == "patch":
        patch += 1
    elif level == "minor":
        minor, patch = minor + 1, 0
    elif level == "major":
        major, minor, patch = major + 1, 0, 0
    else:
        raise VersionError(f"Invalid bump level: {level}")
    return f"{major}.{minor}.{patch}"


def strip_alpha(version: str) -> str:
    """``0.1.0-alpha`` -> ``0.1.0``; error if the ``-alpha`` suffix is absent."""
    if not version.endswith("-alpha"):
        raise VersionError(f"Version must end with -alpha to release (got {version})")
    return version[: -len("-alpha")]


def _minor_series(version: str) -> str:
    """``0.3.1`` / ``0.3.1-alpha`` -> ``0.3.0`` — the X.Y.0 anchor for a ``~=`` range."""
    m = re.match(r"^(\d+)\.(\d+)\.\d+", version.split("-")[0])
    if not m:
        raise VersionError(f"Cannot derive a minor series from version: {version}")
    return f"{m.group(1)}.{m.group(2)}.0"


def rewrite_internal_constraints(version: str) -> str:
    """Pin rfb's native extras to ``~=X.Y.0`` in the root pyproject. Idempotent (any existing
    version marker is replaced). Returns the anchor written."""
    anchor = _minor_series(version)
    content = PYPROJECT_TOML.read_text()
    for name in INTERNAL_EXTRA_DEPS:
        content = re.sub(rf'"{re.escape(name)}(?:[~=<>!][^"]*)?"', f'"{name}~={anchor}"', content)
    PYPROJECT_TOML.write_text(content)
    return anchor


def set_version(new_version: str, files: list[VersionFile] | None = None) -> None:
    """Write ``new_version`` into every version file and repin the native extras in lockstep."""
    for vf in files or discover_version_files():
        write_version_of(vf, new_version)
    rewrite_internal_constraints(new_version)
