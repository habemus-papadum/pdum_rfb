# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

This is a Python library called `rfb` (package name: `rfb`, module name: `pdum.rfb`). Remote Frame Buffer

The project uses a modern Python toolchain with UV for dependency management.

## Important Rules

### Versions and releases
`ship` (habemus-papadum-ship) releases this repository's packages: the PyPI distributions
`habemus-papadum-rfb` (root), `habemus-papadum-nvenc` and `habemus-papadum-vtenc`
(`packages/*`), and the npm packages `@habemus-papadum/rfb-widgets` (`widgets/`),
`rfb-react`, `rfb-svelte` and `rfb-solid` (`widgets/packages/*`). Each package has its own
version and tag series (`<package>-v<version>`, the unscoped name for npm:
`rfb-react-v0.3.1`); between releases the manifest says `<last release>+dev`. Never edit a
version field by hand. `pdum.rfb.__version__` reads the installed metadata.

To release, ask the operator; when they agree, run the release workflow
(`gh workflow run release.yml -f package=<name> -f bump=minor -f dry_run=false`, after a
`dry_run=true` to see the plan; npm packages by their scoped name). Do not publish from this
machine. `habemus-papadum-nvenc` and `-vtenc` are `build = false`: ship tags them and the
`build-nvenc-sdk-wheel.yml` / `build-vtenc-wheel.yml` workflows build and publish the
platform wheels from the tag; never trigger those on a release tag by hand unless a build
failed and is being re-run (recovery: `docs/release_recovery.md`).

Do not update repositories that consume a package you changed; their scheduled refresh does
that. The one exception: if your change needs a newer release of another of our packages,
raise that package's floor here. Do not pin a `habemus-papadum-*` or `@habemus-papadum/*`
package to an exact version without a reason on the same line or in `[tool.ship.pins]`.
Never commit a `path` or `editable` entry in `[tool.uv.sources]`, or a `link:`/`file:`
dependency (`pnpm link` writes one). Run `uv run ship deps check` before you finish.

## Development Commands

### Environment Setup
```bash
# Bootstrap the full toolchain (uv sync, pnpm install, widget build, hooks)
./scripts/setup.sh
```

**Important for Development**:
- Plain `uv sync` and `uv run` keep the locked versions; the lockfile changes only when a command is asked to change it (`uv add`, `uv remove`, `ship deps refresh`). CI uses `--locked`.
- Re-run `./scripts/setup.sh` whenever dependencies change

### Testing
```bash
# Run all tests
uv run pytest

# Run a specific test file
uv run pytest tests/test_example.py

# Run a specific test function
uv run pytest tests/test_example.py::test_version

# Run tests with coverage
uv run pytest --cov=src/pdum/rfb --cov-report=xml --cov-report=term
```

### Code Quality
```bash
# Check code with ruff
uv run ruff check .

# Format code with ruff
uv run ruff format .

# Fix auto-fixable issues
uv run ruff check --fix .
```


### Documentation
```bash
# Serve documentation locally (auto-reloads on changes)
uv run mkdocs serve

# Build documentation
uv run mkdocs build

# Test demo notebooks (REQUIRED after any notebook changes)
./scripts/test_notebooks.sh
```

**Important**: After making any changes to demo notebooks (files in `docs/demos/*.ipynb`), you MUST run `./scripts/test_notebooks.sh` to verify the notebook executes without errors. Do not consider notebook changes complete until this test passes.

### Releasing
```bash
# Plan a release (operators run the real one through the release workflow)
uv run ship release habemus-papadum-rfb --bump minor --dry-run
uv run ship release @habemus-papadum/rfb-react --bump patch --dry-run

# Check the release policy: development links, lockfiles, pins, version markers
uv run ship deps check
```


## Architecture

### Project Structure
- **src/pdum/rfb/**: Main package source code (src-layout)
  - `__init__.py`: Package initialization and version
- **tests/**: Test suite using pytest
  - `test_example.py`: Example tests
- **docs/**: MkDocs documentation with mkdocstrings for API reference
  - `index.md`: Home page
  - `reference.md`: API reference
  - `demos/`: Demo notebooks (if included)

### Key Constraints
- **Python Version**: Requires Python 3.12+
- **Dependency Management**: Uses UV exclusively; uv.lock is committed
- **Build System**: Hatchling builds `habemus-papadum-rfb` (scikit-build-core builds the native members); `ship` runs the build at release time
- **Documentation Style**: NumPy docstring style (see mkdocs.yml)

### Code Standards
- **Ruff Configuration**:
  - Target: Python 3.12
  - Line length: 120 characters
  - Linting rules: E (pycodestyle errors), F (pyflakes), W (warnings), I (isort)
- **Type Hints**: Use type hints where appropriate
- **Docstrings**: NumPy style, include Parameters, Returns, Raises sections

### Testing Strategy
- Test files must start with `test_` prefix
- Test classes must start with `Test` prefix
- Test functions must start with `test_` prefix
- Tests run with `-s` flag (no capture) by default
- Coverage reporting: use `--cov=src/pdum/rfb --cov-report=xml --cov-report=term`

### Testing Configuration
The pytest configuration is in `pyproject.toml`:
```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-s"
python_files = ["test_*.py"]
python_classes = ["Test*"]
python_functions = ["test_*"]
```

Coverage configuration is also in `pyproject.toml`:
```toml
[tool.coverage.run]
source = ["src/pdum/rfb"]
relative_files = true
omit = [
    "*/tests/*",
    "*/testing.py",
]
```

## CI/CD

### Continuous Integration
The project uses GitHub Actions for CI (`.github/workflows/ci.yml`):
- Runs on every push to main and pull requests- Executes linting with ruff
- Runs unit tests with coverage reporting
- Builds documentation to verify it compiles
- Posts coverage report as a PR comment


### Documentation Deployment
Documentation is deployed to GitHub Pages (`.github/workflows/docs.yml`) on every push to
`main`, or by hand via workflow_dispatch. It uses `./scripts/setup.sh` so the widgets are
built before `mkdocs build`.

### Release Process
Releases run from the `release` workflow (`.github/workflows/release.yml`), which calls the
reusable workflow in `habemus-papadum/pdum_ship`. It waits for `ci.yml` to pass on the same
commit, then runs `ship release <package>`:
1. Reads the package's last tag `<package>-v<version>` and applies the requested bump
2. Writes the release version into that package's manifest (and re-locks for a Python package)
3. Runs the package's `before-build` commands (for `habemus-papadum-rfb`: the anywidget bundle
   and the demo SPA), builds, runs the tests, publishes with `PYPI_API_TOKEN` / `NPM_TOKEN`
4. Commits, tags `<package>-v<version>`, pushes commit and tag together
5. Creates the GitHub release
6. Writes `<version>+dev` back and pushes

`habemus-papadum-nvenc` and `habemus-papadum-vtenc` are `build = false`: steps 3 and 5
upload nothing, and `release.yml`'s `build-wheels` job dispatches the package's wheel
workflow for the new tag, which builds the platform wheels, publishes them to PyPI and
attaches them to the release. Versions follow `X.Y.Z+dev` → `X.Y.Z` (tagged) → `X.Y.Z+dev`.
Full detail: docs/development.md; recovery: docs/release_recovery.md.
