"""``pdum.vtenc`` — host NV12 → H.264 Annex B via Apple's VideoToolbox.

A thin binding over ``VTCompressionSession`` that encodes a host-visible (CPU /
Apple-Silicon unified-memory) NV12 frame from any Python buffer-protocol producer
(numpy / an evaluated MLX ``mx.array``) into low-latency H.264 **Annex B**, with **no
PyAV**. The macOS counterpart of ``pdum.nvenc``.

Runtime needs only macOS itself (the VideoToolbox/CoreVideo/CoreMedia frameworks are
system-provided); the wheel bundles no Apple binaries.

    >>> import numpy as np
    >>> from pdum.vtenc import VtEncoder
    >>> enc = VtEncoder(1920, 1080, fps=30, bitrate=12_000_000)
    >>> nv12 = np.zeros((1080 * 3 // 2, 1920), np.uint8)
    >>> annexb = enc.encode(nv12, force_idr=True)
"""

from __future__ import annotations

import importlib.util
import pathlib

__all__ = ["VtEncoder", "supported"]


def _candidate_dirs() -> list[pathlib.Path]:
    """Directories that may hold the built ``_vtenc`` extension.

    A wheel install co-locates it with this file; a scikit-build-core *editable* install
    serves this ``__init__.py`` from ``src/`` but drops the ``.so`` into site-packages —
    both show up in the package's ``__path__``, so search that (with this file's directory
    as a fallback) rather than just ``__file__``'s parent.
    """
    raw: list[str] = []
    try:
        raw.extend(__path__)  # noqa: F821 - set by the import system for packages
    except NameError:  # pragma: no cover - __path__ always set for a package
        pass
    raw.append(str(pathlib.Path(__file__).resolve().parent))
    out: list[pathlib.Path] = []
    seen: set[str] = set()
    for d in raw:
        if d not in seen:
            seen.add(d)
            out.append(pathlib.Path(d))
    return out


def _load():
    """Import the built ``_vtenc`` extension by file path (handles editable installs)."""
    for d in _candidate_dirs():
        matches = sorted(d.glob("_vtenc.*.so")) + sorted(d.glob("_vtenc.so"))
        if not matches:
            continue
        spec = importlib.util.spec_from_file_location(f"{__name__}._vtenc", str(matches[0]))
        if spec is None or spec.loader is None:
            continue
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    return None


_impl = _load()
if _impl is None:
    raise ImportError(
        "pdum.vtenc: no usable _vtenc extension found alongside this module. Reinstall the "
        "habemus-papadum-vtenc wheel for your platform (macOS only)."
    )

VtEncoder = _impl.VtEncoder
supported = _impl.supported
