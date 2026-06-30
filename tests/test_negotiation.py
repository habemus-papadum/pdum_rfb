"""Tests for capability negotiation (guide section 12)."""

import pytest

from pdum.rfb.encoders import available_video_encoders
from pdum.rfb.protocol import (
    CAP_H264_ANNEXB,
    CAP_JPEG,
    CAP_PNG,
    UnsupportedClient,
    select_transport,
)


def test_h264_client_with_server_h264_picks_h264():
    sel = select_transport([CAP_H264_ANNEXB, CAP_JPEG], has_h264=True)
    assert sel.transport == "h264"
    assert sel.codec == "avc1.42E01F"


def test_h264_client_without_server_h264_falls_back_to_image():
    sel = select_transport([CAP_H264_ANNEXB, CAP_JPEG], has_h264=False)
    assert sel.transport == "image"
    assert sel.image_mode == "jpeg"


def test_nvenc_preferred_when_present_even_without_pyav():
    sel = select_transport([CAP_H264_ANNEXB], has_h264=False, has_nvenc=True)
    assert sel.transport == "h264"


def test_image_only_client():
    sel = select_transport([CAP_PNG], has_h264=True)
    assert sel.transport == "image"
    assert sel.image_mode == "png"


def test_prefer_video_false_keeps_image():
    sel = select_transport([CAP_H264_ANNEXB, CAP_JPEG], has_h264=True, prefer_video=False)
    assert sel.transport == "image"


def test_unknown_capabilities_raise():
    with pytest.raises(UnsupportedClient):
        select_transport(["video/whatever"], has_h264=True)


def test_nvenc_encoder_is_registered():
    # The NVENC backend is always registered (buildable only with a GPU), so the
    # server's video_encoder="nvenc_cpu" selection always resolves to a factory.
    assert "nvenc_cpu" in available_video_encoders()
    assert "h264_cpu" in available_video_encoders()
