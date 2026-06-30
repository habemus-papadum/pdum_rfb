"""Tests for the Pillow image encoder."""

from io import BytesIO

import numpy as np
import pytest
from PIL import Image

from pdum.rfb import ImageEncoder, RawFrame
from pdum.rfb.testing import render_test_pattern

_FORMATS = {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}


def _rgb_frame(seq=0, w=64, h=48):
    return RawFrame(seq, w, h, seq * 1000, "rgb24", "cpu", render_test_pattern(seq, w, h))


@pytest.mark.parametrize("mode", ["jpeg", "png", "webp"])
def test_encode_decodes_back_with_correct_dims(mode):
    out = ImageEncoder(mode=mode).encode(_rgb_frame(w=64, h=48))
    assert len(out) == 1
    payload = out[0]
    assert payload.kind == "image"
    assert payload.keyframe is True
    img = Image.open(BytesIO(payload.payload))
    assert img.size == (64, 48)
    assert img.format == _FORMATS[mode]


def test_rgba_jpeg_drops_alpha():
    rgba = np.zeros((32, 32, 4), dtype=np.uint8)
    rgba[..., :3] = (10, 20, 30)
    rgba[..., 3] = 128
    frame = RawFrame(0, 32, 32, 0, "rgba8", "cpu", rgba)
    out = ImageEncoder(mode="jpeg").encode(frame)
    img = Image.open(BytesIO(out[0].payload))
    assert img.mode == "RGB"
    assert img.size == (32, 32)


@pytest.mark.parametrize("mode", ["jpeg", "png", "webp"])
def test_encode_still_is_lossless_png_regardless_of_mode(mode):
    # The "still after settle" upgrade re-sends the resting frame pixel-exact as
    # PNG, even when the live stream is lossy JPEG/WebP.
    frame = _rgb_frame(seq=3, w=64, h=48)
    out = ImageEncoder(mode=mode).encode_still(frame)
    assert len(out) == 1
    payload = out[0]
    assert payload.mime == "image/png"
    assert payload.keyframe is True
    assert payload.seq == 3  # carries the still's (fresh) seq
    decoded = np.asarray(Image.open(BytesIO(payload.payload)).convert("RGB"))
    np.testing.assert_array_equal(decoded, frame.data)  # bit-exact round-trip


def test_unsupported_pixel_format_raises():
    frame = RawFrame(0, 4, 4, 0, "nv12", "cpu", np.zeros((6, 4), dtype=np.uint8))
    with pytest.raises(ValueError):
        ImageEncoder().encode(frame)


def test_non_cpu_frame_raises():
    frame = RawFrame(0, 4, 4, 0, "rgb24", "cuda", object())
    with pytest.raises(TypeError):
        ImageEncoder().encode(frame)
