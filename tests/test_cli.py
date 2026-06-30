"""Smoke tests for the `pdum-rfb` diagnostics CLI.

Typer + Rich are dev dependencies, so the CLI module imports its real form here.
These assert structure only (not hardware-specific results), so they pass on
GPU-less CI as well as on a GPU box.
"""

from __future__ import annotations

from pdum.rfb import cli


def test_app_constructed():
    assert cli.app is not None


def test_probe_all_structure():
    probes, rec = cli._probe_all()
    names = {p.component for p in probes}
    assert {"Python", "Platform", "PyAV", "CuPy", "NVENC SDK (nvenc_spike)"} <= names
    assert isinstance(rec, str) and rec
    for p in probes:
        assert p.status in (cli.OK, cli.WARN, cli.MISSING)
