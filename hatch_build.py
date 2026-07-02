"""Hatch build hook: bundle the git-ignored ``pdum-rfb demo`` SPA when it has been built.

The SPA (``src/pdum/rfb/static/demo/``) is a build artifact — produced by
``pnpm -C widgets build:demo``, not committed to git. It must ship in the sdist + wheel when
present, but a plain ``force-include`` entry hard-fails EVERY build (including editable
installs and ``uv sync``) whenever the dir is absent — e.g. a fresh checkout that hasn't run
``build:demo``, which is exactly CI's test job. So force-include it here CONDITIONALLY: only
when the directory exists. Absent → the artifact simply carries no SPA and ``pdum-rfb demo``
serves its "build me" placeholder (see ``demo_server._PLACEHOLDER_HTML``). The release CI
builds the SPA before packaging, so published wheels always contain it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class DemoSpaBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        spa = Path(self.root) / "src" / "pdum" / "rfb" / "static" / "demo"
        if spa.is_dir():
            build_data.setdefault("force_include", {})[str(spa)] = "pdum/rfb/static/demo"
