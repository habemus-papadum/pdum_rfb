"""Hatch build hook: bundle the git-ignored, on-demand JS build artifacts when they exist.

Two artifacts live under ``src/pdum/rfb/static/`` and are produced by the ``widgets/`` build,
NOT committed to git:

* the anywidget bundle — ``widget.js`` + ``widget.css`` (``pnpm -C widgets build:anywidget``);
* the ``pdum-rfb demo`` SPA — the ``demo/`` directory (``pnpm -C widgets build:demo``).

Each must ship in the wheel when present, but a plain ``force-include`` entry hard-fails EVERY
build (including editable installs and ``uv sync``) whenever the target is absent — e.g. a fresh
checkout that hasn't run the builds, which is exactly CI's test job. So force-include each here
CONDITIONALLY: only when it exists. Absent → the wheel simply carries no bundle, and at runtime
the widget renders its fallback cell (see ``notebook._MISSING_BUNDLE_ESM``) and ``pdum-rfb demo``
serves its "build me" placeholder (see ``demo_server._PLACEHOLDER_HTML``). The release CI builds
both before packaging — and re-inspects the built wheel — so published wheels always contain them.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class StaticArtifactsBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        static = Path(self.root) / "src" / "pdum" / "rfb" / "static"
        force_include = build_data.setdefault("force_include", {})

        # anywidget bundle (files) — present only after `build:anywidget`.
        for name in ("widget.js", "widget.css"):
            f = static / name
            if f.is_file():
                force_include[str(f)] = f"pdum/rfb/static/{name}"

        # `pdum-rfb demo` SPA (directory) — present only after `build:demo`.
        spa = static / "demo"
        if spa.is_dir():
            force_include[str(spa)] = "pdum/rfb/static/demo"
