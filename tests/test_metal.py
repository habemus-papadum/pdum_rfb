"""Tests for the MLX / Apple Metal ingress path (:mod:`pdum.rfb.metal`).

Mirrors the CUDA path in ``test_gpu.py``: an MLX (Metal, unified-memory) frame is recognized
by ``publish()``, converted RGB(A)→NV12 on the GPU with a custom ``mx.fast.metal_kernel``, and
encoded by VideoToolbox — no CPU color pass. The whole module skips unless macOS + MLX + a
usable VideoToolbox H.264 session, so CI on non-Apple machines stays green.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
import websockets.asyncio.client

from pdum.rfb import metal
from pdum.rfb.protocol import CAP_H264_ANNEXB, unpack_binary_message
from pdum.rfb.testing import decode_annexb, has_sps_pps_idr, starts_with_start_code

pytestmark = pytest.mark.skipif(
    not (metal.mlx_available()),
    reason="MLX / Apple Metal not available",
)


def _vtenc_ok() -> bool:
    from pdum.rfb.encoders.vtenc import vtenc_available

    return vtenc_available()


W, H = 256, 192


def _cpu_nv12_reference(rgb: np.ndarray) -> np.ndarray:
    """BT.601 limited-range NV12, the ground truth the MLX kernel must match."""
    h, w = rgb.shape[:2]
    r, g, b = (rgb[..., i].astype(np.float32) for i in range(3))
    out = np.empty((h + h // 2, w), np.uint8)
    out[:h] = np.clip(0.257 * r + 0.504 * g + 0.098 * b + 16, 0, 255).astype(np.uint8)
    uv = out[h:].reshape(h // 2, w // 2, 2)
    uv[..., 0] = np.clip((-0.148 * r - 0.291 * g + 0.439 * b + 128)[::2, ::2], 0, 255).astype(np.uint8)
    uv[..., 1] = np.clip((0.439 * r - 0.368 * g - 0.071 * b + 128)[::2, ::2], 0, 255).astype(np.uint8)
    return out


def test_publish_recognizes_mlx_array_as_metal_frame():
    import mlx.core as mx

    from pdum.rfb.display import Display, _is_metal_tensor

    assert _is_metal_tensor(mx.zeros((4, 4, 4), dtype=mx.uint8))
    assert not _is_metal_tensor(np.zeros((4, 4, 4), np.uint8))

    d = Display(W, H)
    d.publish(mx.zeros((H, W, 4), dtype=mx.uint8))
    f = d._latest
    assert f.memory == "metal" and f.pixel_format == "rgba8" and (f.width, f.height) == (W, H)
    # A plain numpy frame is still a host frame.
    d.publish(np.zeros((H, W, 3), np.uint8))
    assert d._latest.memory == "cpu"


@pytest.mark.parametrize("channels", [3, 4])
def test_mlx_rgb_to_nv12_matches_cpu_reference(channels):
    import mlx.core as mx

    rng = np.random.default_rng(0)
    rgb = rng.integers(0, 256, size=(H, W, channels), dtype=np.uint8)
    got = metal.to_host_nv12(metal.rgb_to_nv12(mx.array(rgb)))
    ref = _cpu_nv12_reference(rgb[..., :3])
    assert got.shape == ref.shape
    assert int(np.abs(got.astype(int) - ref.astype(int)).max()) <= 1  # GPU rounding parity


def test_metal_frame_infers_pixel_format():
    import mlx.core as mx

    assert metal.metal_frame(mx.zeros((H, W, 3), mx.uint8)).pixel_format == "rgb24"
    assert metal.metal_frame(mx.zeros((H, W, 4), mx.uint8)).pixel_format == "rgba8"
    nv = metal.metal_frame(mx.zeros((H + H // 2, W), mx.uint8))
    assert nv.pixel_format == "nv12" and (nv.width, nv.height) == (W, H) and nv.memory == "metal"


@pytest.mark.skipif(not _vtenc_ok(), reason="VideoToolbox H.264 not available")
def test_wrapper_encodes_metal_rgba_via_gpu_convert():
    import mlx.core as mx

    from pdum.rfb.encoders.vtenc import VideoToolboxEncoder
    from pdum.rfb.types import RawFrame

    n = 12
    enc = VideoToolboxEncoder(width=W, height=H, fps=12)
    blob = b""
    for i in range(n):
        cols = (np.arange(W)[None, :] + i * 4) % 256 * np.ones((H, 1))
        planes = [cols, np.full((H, W), 80), np.full((H, W), 160), np.full((H, W), 255)]
        rgba = mx.array(np.dstack(planes).astype(np.uint8))
        for p in enc.encode(RawFrame(i, W, H, i * 1000, "rgba8", "metal", rgba), force_keyframe=(i == 0)):
            blob += p.payload
    blob += b"".join(p.payload for p in enc.flush())
    enc.close()
    frames = decode_annexb(blob)
    assert len(frames) >= n - 1 and all(f.width == W and f.height == H for f in frames)


@pytest.mark.skipif(not _vtenc_ok(), reason="VideoToolbox H.264 not available")
def test_to_host_rgb_downloads_metal_frames():
    import mlx.core as mx

    from pdum.rfb.types import RawFrame

    rgba = mx.array(np.full((H, W, 4), (30, 120, 200, 255), np.uint8))
    host = metal.to_host_rgb(RawFrame(0, W, H, 0, "rgba8", "metal", rgba))
    assert host.shape == (H, W, 3) and host.dtype == np.uint8
    nv = metal.rgb_to_nv12(rgba)
    host2 = metal.to_host_rgb(metal.metal_frame(nv))  # nv12 -> rgb host fallback
    assert host2.shape == (H, W, 3)


def test_mlx_demo_scene_publishes_metal_and_downloads_on_cpu_encoders():
    """The `mlx_shader` demo scene returns a Metal `mx.array`; publishing it yields a
    `memory="metal"` frame, and the CPU / image encoders download it automatically (so the
    demo works across live backend switches, not just on VideoToolbox)."""
    from pdum.rfb.demos import _mlx_available, _MlxShader
    from pdum.rfb.display import Display, _is_metal_tensor
    from pdum.rfb.encoders.base import build_encoder
    from pdum.rfb.protocol import DEFAULT_H264_CODEC, BackendSelection

    assert _mlx_available()
    scene = _MlxShader()
    rendered = scene.frame(0, 0.3, W, H)
    assert _is_metal_tensor(rendered), "the demo scene should return a Metal mx.array"

    d = Display(W, H)
    d.publish(rendered)
    frame = d._latest
    assert frame.memory == "metal"

    # h264_cpu downloads the Metal frame to host and encodes it.
    enc = build_encoder(BackendSelection(transport="h264", codec=DEFAULT_H264_CODEC), width=W, height=H)
    blob = b"".join(p.payload for p in enc.encode(frame, force_keyframe=True))
    d.publish(scene.frame(1, 0.4, W, H))
    blob += b"".join(p.payload for p in enc.encode(d._latest))
    blob += b"".join(p.payload for p in enc.flush())
    enc.close()
    assert decode_annexb(blob), "metal frame should encode+decode via the CPU download path"

    # image transport downloads too.
    img = build_encoder(BackendSelection(transport="image", mime="image/jpeg", image_mode="jpeg"), width=W, height=H)
    assert len(img.encode(frame)[0].payload) > 0


@pytest.mark.skipif(not _vtenc_ok(), reason="VideoToolbox H.264 not available")
async def test_serve_gpu_selects_vtenc_metal_and_streams_h264():
    import mlx.core as mx

    from pdum.rfb.server import DEFAULT_STREAM, serve

    display = await serve(W, H, port=0, gpu=True)
    try:
        host = display.server._streams[DEFAULT_STREAM]
        assert host.video_encoder == "vtenc" and host._gpu_kind == "metal"

        display.publish(mx.zeros((H, W, 4), dtype=mx.uint8))
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{display.port}") as ws:
            await ws.send(json.dumps({"type": "hello", "supported": [CAP_H264_ANNEXB, "image/jpeg"]}))
            config = json.loads(await ws.recv())
            assert config["type"] == "config" and config["transport"] == "webcodecs"
            header, payload = unpack_binary_message(await ws.recv())
            assert header["type"] == "video_chunk" and header["seq"] == 0 and len(payload) > 0
            # First AU from the Metal→VideoToolbox path is a valid Annex B keyframe.
            assert starts_with_start_code(payload) and has_sps_pps_idr(payload)
    finally:
        await display.aclose()


@pytest.mark.skipif(not _vtenc_ok(), reason="VideoToolbox H.264 not available")
async def test_serve_gpu_metal_image_viewer_downloads_to_host():
    """An image-transport viewer of a gpu=True (Metal) stream still works via MetalHostFrameAdapter."""
    import mlx.core as mx

    from pdum.rfb.server import serve

    display = await serve(W, H, port=0, gpu=True)
    try:
        display.publish(mx.zeros((H, W, 4), dtype=mx.uint8))
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{display.port}") as ws:
            await ws.send(json.dumps({"type": "hello", "supported": ["image/jpeg", "image/png"]}))
            config = json.loads(await ws.recv())
            assert config["transport"] == "image"
            header, payload = unpack_binary_message(await ws.recv())
            assert header["type"] == "image_frame" and len(payload) > 0
    finally:
        await display.aclose()


def test_own_frames_raises_for_metal_frame():
    """own_frames is unsupported for Metal frames — MLX arrays are immutable, so the borrow
    contract already holds. publish() raises NotImplementedError (after the loop-thread materialize)."""
    import mlx.core as mx

    from pdum.rfb.display import Display

    d = Display(W, H, own_frames=True)
    with pytest.raises(NotImplementedError):
        d.publish(mx.zeros((H, W, 4), dtype=mx.uint8))
