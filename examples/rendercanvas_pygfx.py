"""Stream a pygfx scene to the browser via the ``pdum.rfb`` rendercanvas backend.

Two modes:

* ``--check`` — headless one-shot: render a single frame and save it to a PNG. Proves the
  whole chain (pygfx -> wgpu -> bitmap present -> ``Display.publish``) without a browser.
* default — ``serve()`` a live, orbit-controllable spinning cube at ``ws://127.0.0.1:8765``;
  point the ``@habemus-papadum/rfb-widgets`` demo (or your own client) at it.

Needs the ``viz`` dev group (``rendercanvas`` + ``wgpu`` + ``pygfx``); a plain ``uv sync``
installs it (see ``[tool.uv] default-groups`` in ``pyproject.toml``).

Software rendering (no GPU) via Mesa **lavapipe** — handy for headless boxes / CI::

    VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json WGPU_BACKEND_TYPE=Vulkan \\
        uv run python examples/rendercanvas_pygfx.py --check
"""

from __future__ import annotations

import argparse
import asyncio

import numpy as np
import pygfx
import pylinalg as la

WIDTH, HEIGHT = 640, 480


def build_scene(canvas):
    """Build a lit cube scene and a camera framing it; return (renderer, scene, camera, cube)."""
    renderer = pygfx.renderers.WgpuRenderer(canvas)
    scene = pygfx.Scene()
    scene.add(pygfx.AmbientLight(intensity=0.4))
    light = pygfx.DirectionalLight(intensity=2.5)
    light.local.position = (1, 1, 1)
    scene.add(light)

    cube = pygfx.Mesh(pygfx.box_geometry(1, 1, 1), pygfx.MeshPhongMaterial(color="#3388ff"))
    scene.add(cube)

    camera = pygfx.PerspectiveCamera(70, WIDTH / HEIGHT)
    camera.show_object(scene, view_dir=(-1, -1, -1))
    return renderer, scene, camera, cube


def check(out: str = "rendercanvas_cube.png") -> None:
    """Render one frame headlessly and save it; assert a non-blank image was published."""
    from PIL import Image

    from pdum.rfb.display import Display
    from pdum.rfb.rendercanvas import RfbRenderCanvas

    display = Display(WIDTH, HEIGHT)
    canvas = RfbRenderCanvas(display=display, size=(WIDTH, HEIGHT))
    renderer, scene, camera, cube = build_scene(canvas)
    cube.local.rotation = la.quat_from_euler((0.6, 0.9, 0.0))

    canvas.request_draw(lambda: renderer.render(scene, camera))
    canvas.force_draw()  # synchronous render -> present(bitmap) -> _rc_present_bitmap -> publish

    frame = display._latest
    assert frame is not None, "nothing was published"
    rgb = np.asarray(frame.data)[:, :, :3]
    ncolors = len(np.unique(rgb.reshape(-1, 3), axis=0))
    assert ncolors > 1, "published frame is uniform — nothing rendered"
    Image.fromarray(rgb).save(out)
    print(f"OK: published {frame.width}x{frame.height} {frame.pixel_format}, {ncolors} colors -> {out}")


async def serve() -> None:
    """Serve a live, spinning, orbit-controllable cube over pdum.rfb."""
    import pdum.rfb as rfb
    from pdum.rfb.rendercanvas import RfbRenderCanvas, loop

    display = await rfb.serve(WIDTH, HEIGHT, port=8765)
    canvas = RfbRenderCanvas(display=display, size=(WIDTH, HEIGHT))
    renderer, scene, camera, cube = build_scene(canvas)
    pygfx.OrbitController(camera, register_events=renderer)  # drag to orbit, wheel to zoom

    angle = 0.0

    def animate():
        nonlocal angle
        angle += 0.01
        cube.local.rotation = la.quat_from_euler((angle * 0.6, angle, 0.0))
        renderer.render(scene, camera)
        canvas.request_draw(animate)

    canvas.request_draw(animate)
    print(f"serving a spinning cube at ws://127.0.0.1:{display.port}  (Ctrl-C to stop)")
    try:
        await loop.run_async()  # runs on this asyncio loop alongside the WS server
    finally:
        await display.aclose()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="headless one-shot render to a PNG")
    ap.add_argument("--out", default="rendercanvas_cube.png", help="output PNG for --check")
    args = ap.parse_args()
    if args.check:
        check(args.out)
    else:
        asyncio.run(serve())
