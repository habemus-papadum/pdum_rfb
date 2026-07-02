# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

This is a Python library called `rfb` (package name: `rfb`, module name: `pdum.rfb`). Remote Frame Buffer

The project uses a modern Python toolchain with UV for dependency management.

## Important Rules

### Version Management
**NEVER modify the version number in any file.** Version numbers are managed exclusively by humans. Do not change:
- `pyproject.toml` version field
- `src/pdum/rfb/__init__.py` `__version__` variable
- Any version references in documentation

If you think a version change is needed, inform the user but do not make the change yourself.

### Release Management
**NEVER TRIGGER A RELEASE, AND NEVER PUBLISH.** Releasing is a single GitHub Actions workflow —
`.github/workflows/release.yml`, a `workflow_dispatch` — run by a HUMAN from the Actions UI (or
`gh workflow run release.yml`). Triggering it (with `dry_run=false`) bumps the version, tags
`vX.Y.Z`, builds the wheel matrix, and publishes to PyPI + npm. There is no local release script.
- `./scripts/publish.sh` is a token-based manual break-glass fallback (publishes to PyPI directly
  from `.env`).
- `scripts/_versioning.py` is the shared version library the workflow calls; do not hand-run its
  `set` command to change committed versions.

**These should ONLY be run by a human who fully understands the consequences.** Do not:
- Dispatch the release workflow or run `publish.sh` under any circumstances (a real publish)
- Suggest triggering a release unless the user explicitly asks about the release process
- Include release/publish in automated workflows or scripts

If the user needs to make a release, explain the process (`docs/development.md` → *Releasing*;
recovery in `docs/release_recovery.md`) but let them run the scripts themselves.

## Development Commands

### Environment Setup
```bash
# Bootstrap the full toolchain (uv sync, pnpm install, widget build, hooks)
./scripts/setup.sh
```

**Important for Development**:
- Use `uv sync --frozen` to ensure the lockfile is used without modification, maintaining reproducible builds
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

### Publishing
```bash
# Build and publish to PyPI (requires credentials)
./scripts/publish.sh
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
- **Python Version**: Requires Python 3.14+
- **Dependency Management**: Uses UV exclusively; uv.lock is committed
- **Build System**: Uses Hatch/Hatchling for building distributions
- **Documentation Style**: NumPy docstring style (see mkdocs.yml)

### Code Standards
- **Ruff Configuration**:
  - Target: Python 3.14
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
Documentation is deployed to GitHub Pages (`.github/workflows/docs.yml`):
- Triggered when a GitHub release is published
- Can also be triggered manually via workflow_dispatch
- Uses `./scripts/setup.sh` to ensure widgets are built before running `mkdocs build`

### Release Process
Releasing is a single CI workflow — `.github/workflows/release.yml`, a `workflow_dispatch` a
HUMAN runs from the Actions UI (inputs: `bump` = patch/minor/major, `skip_ci_check`, `dry_run`). It
does **not** re-run tests — it trusts CI. In one run it:
1. Requires the commit's `ci.yml` run (Linux tests + widgets) to be green — waiting out an
   in-progress run; `skip_ci_check` overrides the gate
2. Computes the release version = `bump(last vX.Y.Z tag, bump)` — the size is decided **at
   release**, against the last real release (tag-as-truth), never guessed a release ahead
3. Writes the version across every file, commits, tags `vX.Y.Z`, pushes
4. Builds the wheel matrix (rfb + native nvenc/vtenc) from the tag
5. Publishes npm then PyPI (token secrets — see the trusted-publishing migration proposal)
6. Cuts the GitHub release and returns `main` to the `X.Y.Z+dev` working marker

Between releases the working tree carries `X.Y.Z+dev` (last release + a WIP flag; a PEP 440 local
version PyPI refuses to upload). `dry_run` computes the version and shows the diff without
committing or publishing. Full detail: docs/development.md.
