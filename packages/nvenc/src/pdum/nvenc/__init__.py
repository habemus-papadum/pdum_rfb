"""``pdum.nvenc`` — GPU NV12 → H.264/HEVC Annex B via NVIDIA's Video Codec SDK.

A thin binding over NVIDIA's ``NvEncoderCuda`` (vendored verbatim; see PROVENANCE.md)
that encodes a GPU-resident NV12 frame from any ``__cuda_array_interface__`` producer
(CuPy / PyTorch / Numba) with **no host copy and no PyAV**. The companion to
``pdum.rfb``'s PyAV-based encoders.

Two NVENC ABI builds (12.1 and 13.0) ship in the wheel; this module loads whichever
the host driver supports (preferring the newer), so one wheel works across drivers.

Runtime needs only the host NVIDIA driver (``libcuda`` + ``libnvidia-encode``); the
wheel bundles no NVIDIA binaries.

    >>> import cupy as cp
    >>> from pdum.nvenc import NvencEncoder
    >>> enc = NvencEncoder(1920, 1080, codec="h264", preset="p3", tuning="ll", bitrate=10_000_000)
    >>> annexb = enc.encode(cp.zeros((1080 * 3 // 2, 1920), cp.uint8), force_idr=True)
"""

from __future__ import annotations

import importlib.util
import pathlib

__all__ = ["NvencEncoder", "nvtx_enabled", "abi"]


def _candidate_dirs() -> list[pathlib.Path]:
    """Directories that may hold the built ``_nvenc_*`` extensions.

    A wheel install co-locates them with this file; a scikit-build-core *editable*
    install serves this ``__init__.py`` from ``src/`` but drops the ``.so`` into
    site-packages — both show up in the package's ``__path__``, so search that (with
    this file's directory as a fallback) rather than just ``__file__``'s parent.
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


def _load(stem: str):
    """Import a built ABI extension (``_nvenc_121`` / ``_nvenc_130``) by file path.

    Both files export the same ``PyInit__nvenc`` symbol, so they are loaded
    explicitly rather than via a normal ``import``.
    """
    for d in _candidate_dirs():
        matches = sorted(d.glob(f"{stem}.*.so")) + sorted(d.glob(f"{stem}.so"))
        if not matches:
            continue
        spec = importlib.util.spec_from_file_location(f"{__name__}._nvenc", str(matches[0]))
        if spec is None or spec.loader is None:
            continue
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    return None


def _select():
    """Pick the ABI the driver supports, newest first; fall back to whatever loads."""
    loaded = []
    for stem in ("_nvenc_130", "_nvenc_121"):
        mod = _load(stem)
        if mod is None:
            continue
        loaded.append((stem, mod))
        try:
            if mod.supported():
                return stem, mod
        except Exception:
            continue
    return loaded[0] if loaded else (None, None)


abi, _impl = _select()
if _impl is None:
    raise ImportError(
        "pdum.nvenc: no usable NVENC extension found (expected _nvenc_121 / _nvenc_130 "
        "alongside this module). Reinstall the habemus-papadum-nvenc wheel for your "
        "platform; an NVIDIA driver + NVENC GPU are required at runtime."
    )

NvencEncoder = _impl.NvencEncoder
nvtx_enabled = _impl.nvtx_enabled
