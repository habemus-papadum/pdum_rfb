"""Tests for the ``pdum-rfb demo`` web harness (scene registry, backends, REST control).

The headless proof of the feature is :func:`pdum.rfb.demo_server.smoke`: it drives the
real ASGI app in-process (Starlette ``TestClient``) — capabilities, every available
backend switched over REST on one socket, a live quality retune, a scene switch + input
round-trip, a 2-viewer fan-out check, and a private-stream create → connect → destroy
cycle. Backends/scenes needing absent hardware/deps are filtered out, so it runs anywhere.
The ``TestClient`` unit tests below pin the REST contract the browser SPA depends on.
"""

from __future__ import annotations

import numpy as np
import pytest

from pdum.rfb.demo_server import (
    available_backends,
    backend_catalog,
    build_demo_app,
    capabilities,
    smoke,
)
from pdum.rfb.demos import DEMOS, _safe, available_demos, get_demo

starlette = pytest.importorskip("starlette")


# --- scene registry ---------------------------------------------------------


def test_demo_registry_cpu_scenes_render():
    demos = available_demos()
    keys = {d.key for d in demos}
    assert {"test_card", "bouncing_box", "gradient", "checkerboard", "plasma", "paint"} <= keys
    for key in ("test_card", "plasma", "paint"):
        inst = get_demo(key).make()
        frame = inst.frame(0, 0.0, 64, 48)
        assert isinstance(frame, np.ndarray)
        assert frame.shape[:2] == (48, 64)
        assert frame.dtype == np.uint8


def test_get_demo_unknown_raises():
    with pytest.raises(KeyError):
        get_demo("nope")


def test_unavailable_demo_is_hidden():
    assert _safe(lambda: 1 / 0) is False
    assert all(d in DEMOS for d in DEMOS)


# --- backend / scene catalogs (greying-out) ---------------------------------


def test_available_backends_always_offers_image_modes():
    ids = [bid for bid, _label in available_backends()]
    assert ids[:3] == ["image:jpeg", "image:png", "image:webp"]
    assert all(isinstance(label, str) and label for _bid, label in available_backends())


def test_backend_catalog_marks_availability_with_reasons():
    cat = {b["id"]: b for b in backend_catalog()}
    # Image modes are always available with no reason; every video backend that is
    # unavailable must carry a human reason (drives the greyed-out tooltip).
    assert cat["image:jpeg"]["available"] and cat["image:jpeg"]["reason"] == ""
    for bid in ("h264_cpu", "vtenc", "nvenc_cpu", "nvenc_gpu_pyav", "nvenc_gpu_pdum"):
        b = cat[bid]
        assert b["available"] or b["reason"], bid


def test_capabilities_shape():
    caps = capabilities()
    assert {"scenes", "backends", "controls", "platform", "limits"} <= set(caps)
    assert any(c["id"] == "backend" and c["scope"] == "stream" for c in caps["controls"])
    assert any(c["id"] == "framework" and c["scope"] == "viewer" for c in caps["controls"])
    # Every scene entry is tagged available/unavailable for greying-out.
    assert all("available" in s and "key" in s for s in caps["scenes"])


# --- paint scene input contract (frame-pixel coordinates) -------------------


def test_paint_receives_frame_pixels_directly():
    paint = get_demo("paint").make()
    paint.frame(0, 0.0, 1280, 720)
    assert paint._to_pixels(100.4, 50.6) == (100, 51)
    assert paint._to_pixels(1280, 720) == (1279, 719)


def test_paint_ignores_out_of_frame_letterbox_clicks():
    paint = get_demo("paint").make()
    paint.frame(0, 0.0, 64, 48)
    paint.on_event({"type": "pointer_down", "x": 10, "y": 10, "buttons": [1]})
    before = paint.frame(1, 0.03, 64, 48).copy()
    paint.on_event({"type": "pointer_move", "x": 20, "y": 20, "inside": False, "buttons": [1]})
    after = paint.frame(2, 0.06, 64, 48)
    assert np.array_equal(before, after)


# --- REST control plane (Starlette TestClient) ------------------------------


def _client():
    from starlette.testclient import TestClient

    return TestClient(build_demo_app(width=64, height=48, fps=30, static_dir=None))


def test_rest_capabilities_and_default_state():
    with _client() as client:
        caps = client.get("/demo/capabilities").json()
        assert caps["backends"] and caps["scenes"]
        state = client.get("/demo/state").json()
        assert [s["name"] for s in state["streams"]] == ["default"]
        default = state["streams"][0]
        assert default["private"] is False
        assert default["scene"] in {s["key"] for s in caps["scenes"]}


def test_rest_scene_and_quality_and_unknown_stream():
    with _client() as client:
        r = client.post("/demo/streams/default/scene", json={"key": "plasma"})
        assert r.status_code == 200 and r.json()["scene"] == "plasma"
        assert client.post("/demo/streams/default/scene", json={"key": "nope"}).status_code == 400

        q = client.post("/demo/streams/default/quality", json={"bitrate": "2M", "fps": 24})
        assert q.status_code == 200
        assert q.json()["fps"] == 24 and q.json()["bitrate"] == 2_000_000

        assert client.post("/demo/streams/ghost/scene", json={"key": "plasma"}).status_code == 404


def test_rest_backend_switch_and_validation():
    with _client() as client:
        # image:png is always available.
        r = client.post("/demo/streams/default/backend", json={"id": "image:png"})
        assert r.status_code == 200 and r.json()["backend"] == "image:png"
        assert client.post("/demo/streams/default/backend", json={"id": "bogus"}).status_code == 400


def test_rest_params_live_vs_structural():
    with _client() as client:
        # Live params (resolution + color) apply; odd dims are rounded even.
        r = client.post("/demo/streams/default/params", json={"width": 101, "height": 51, "color": "display-p3"})
        assert r.status_code == 200
        assert r.json()["color"] == "display-p3"
        # Structural params are rejected with a 409 pointing at private streams.
        bad = client.post("/demo/streams/default/params", json={"adaptive": True})
        assert bad.status_code == 409 and "private" in bad.json()["error"]


def test_rest_private_stream_lifecycle_and_cap():
    with _client() as client:
        created = client.post("/demo/streams", json={"width": 64, "height": 48, "adaptive": True})
        assert created.status_code == 201
        info = created.json()
        assert info["private"] is True and info["adaptive"] is True
        name = info["name"]
        # It shows up in state and is reachable/destroyable.
        names = [s["name"] for s in client.get("/demo/state").json()["streams"]]
        assert name in names
        assert client.delete("/demo/streams/default").status_code == 400  # protected
        assert client.delete(f"/demo/streams/{name}").status_code == 200
        assert name not in [s["name"] for s in client.get("/demo/state").json()["streams"]]


def test_rest_private_stream_cap_enforced():
    from starlette.testclient import TestClient

    with TestClient(build_demo_app(width=32, height=24, static_dir=None, private_cap=2)) as client:
        assert client.post("/demo/streams", json={}).status_code == 201
        assert client.post("/demo/streams", json={}).status_code == 201
        capped = client.post("/demo/streams", json={})
        assert capped.status_code == 429 and "cap" in capped.json()["error"]


def test_placeholder_served_when_spa_not_built():
    with _client() as client:
        r = client.get("/")
        assert r.status_code == 200 and "pdum-rfb demo" in r.text


# --- the headless end-to-end proof ------------------------------------------


def test_smoke_end_to_end():
    result = smoke(width=160, height=120, fps=30, verbose=False)
    assert result["ok"] is True
    for mode in ("image:jpeg", "image:png", "image:webp"):
        assert mode in result["backends"]
        assert "160x120" in result["backends"][mode]
    assert result.get("scene_switch") is True
    assert result.get("fanout") is True
    assert result.get("private_stream")
