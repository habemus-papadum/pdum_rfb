"""End-to-end render test for the rendercanvas backend.

Renders a real ``pygfx`` cube through :class:`pdum.rfb.rendercanvas.RfbRenderCanvas`
(pygfx → wgpu → bitmap present → ``Display.publish``) and asserts a non-blank frame was
published. This is the only test that exercises the full GPU path; the bridge tests in
``test_rendercanvas_backend.py`` cover the present/event plumbing without wgpu.

Skips cleanly unless ``pygfx`` / ``wgpu`` / ``rendercanvas`` are installed **and** a wgpu
adapter is usable (a real GPU, or Mesa **lavapipe** — ``apt install mesa-vulkan-drivers``
on Linux/CI). On Linux it auto-selects lavapipe when present, so the render is
deterministic software rendering; on macOS wgpu uses Metal.
"""

import os
import pathlib
import sys

import pytest

# Prefer Mesa lavapipe (software Vulkan) on Linux for a deterministic, GPU-free render.
# Must run before wgpu is imported. No-op on macOS (wgpu uses Metal) or without lavapipe.
_LVP = pathlib.Path("/usr/share/vulkan/icd.d/lvp_icd.json")
if (
    sys.platform == "linux"
    and _LVP.exists()
    and not (os.environ.get("VK_DRIVER_FILES") or os.environ.get("VK_ICD_FILENAMES"))
):
    os.environ["VK_DRIVER_FILES"] = str(_LVP)
    os.environ.setdefault("WGPU_BACKEND_TYPE", "Vulkan")

pygfx = pytest.importorskip("pygfx")
pytest.importorskip("rendercanvas")
wgpu = pytest.importorskip("wgpu")


def _usable_adapter() -> bool:
    try:
        return wgpu.gpu.request_adapter_sync(power_preference="high-performance") is not None
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _usable_adapter(), reason="no usable wgpu adapter (need a GPU or Mesa lavapipe)")


def test_pygfx_renders_through_backend():
    import numpy as np
    import pylinalg as la

    from pdum.rfb.display import Display
    from pdum.rfb.rendercanvas import RfbRenderCanvas

    w, h = 160, 120
    display = Display(w, h)
    canvas = RfbRenderCanvas(display=display, size=(w, h))

    renderer = pygfx.renderers.WgpuRenderer(canvas)
    scene = pygfx.Scene()
    scene.add(pygfx.AmbientLight(intensity=0.4))
    light = pygfx.DirectionalLight(intensity=2.5)
    light.local.position = (1, 1, 1)
    scene.add(light)
    cube = pygfx.Mesh(pygfx.box_geometry(1, 1, 1), pygfx.MeshPhongMaterial(color="#3388ff"))
    cube.local.rotation = la.quat_from_euler((0.6, 0.9, 0.0))
    scene.add(cube)
    camera = pygfx.PerspectiveCamera(70, w / h)
    camera.show_object(scene, view_dir=(-1, -1, -1))

    canvas.request_draw(lambda: renderer.render(scene, camera))
    canvas.force_draw()  # synchronous render -> present(bitmap) -> _rc_present_bitmap -> publish

    frame = display._latest
    assert frame is not None, "backend published nothing"
    assert frame.pixel_format == "rgba8" and (frame.width, frame.height) == (w, h)
    rgb = np.asarray(frame.data)[:, :, :3]
    assert len(np.unique(rgb.reshape(-1, 3), axis=0)) > 1, "published frame is blank/uniform"
