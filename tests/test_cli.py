"""Smoke tests for the `pdum-rfb` diagnostics CLI.

Typer + Rich are dev dependencies, so the CLI module imports its real form here.
These assert structure only (not hardware-specific results), so they pass on
GPU-less CI as well as on a GPU box.
"""

from __future__ import annotations

import os

import pytest

from pdum.rfb import cli


def test_app_constructed():
    assert cli.app is not None


def test_notebook_assets_resolve():
    # In a dev checkout these fall back to docs/demos/; in a wheel they're package data.
    for name in ("jupyter-demo.ipynb", "marimo-demo.py"):
        p = cli._notebook_asset(name)
        assert p is not None and p.is_file(), name


@pytest.mark.parametrize(
    ("kind", "fname", "launcher"),
    [("jupyter", "jupyter-demo.ipynb", ["jupyter", "lab"]), ("marimo", "marimo-demo.py", ["marimo", "edit"])],
)
def test_run_notebook_demo_copies_and_execs(tmp_path, monkeypatch, kind, fname, launcher):
    # Pretend the launcher is installed and stub the process-replacing exec.
    monkeypatch.setattr("importlib.util.find_spec", lambda _m: object())
    captured: dict[str, list[str]] = {}

    def fake_execvp(file: str, args: list[str]) -> None:
        captured["file"] = file
        captured["args"] = args

    monkeypatch.setattr(os, "execvp", fake_execvp)

    cli._run_notebook_demo(kind, str(tmp_path), open_browser=False)

    assert (tmp_path / fname).is_file()  # copied out to the working dir
    assert captured["file"] == launcher[0]
    assert captured["args"][:2] == launcher and captured["args"][2].endswith(fname)
    assert captured["args"][-1] in ("--no-browser", "--headless")  # --no-open honored


def test_notebook_demo_missing_launcher_errors(tmp_path, monkeypatch):
    monkeypatch.setattr("importlib.util.find_spec", lambda _m: None)  # launcher not installed
    with pytest.raises(SystemExit) as exc:
        cli._run_notebook_demo("jupyter", str(tmp_path), open_browser=True)
    assert exc.value.code == 1


def test_probe_all_structure():
    probes, rec = cli._probe_all()
    names = {p.component for p in probes}
    assert {
        "Python",
        "Platform",
        "PyAV",
        "CuPy",
        "nvenc-gpu-pdum — NVENC SDK (pdum.nvenc)",
        "vtenc — Apple VideoToolbox (H.264)",
        "mlx — Apple Metal (GPU RGB→NV12)",
    } <= names
    assert isinstance(rec, str) and rec
    for p in probes:
        assert p.status in (cli.OK, cli.WARN, cli.MISSING)
