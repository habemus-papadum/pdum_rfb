"""Smoke tests for the offline encoder benchmark."""

import math

import pytest

from pdum.rfb.benchmark import benchmark_h264, benchmark_image, benchmark_nvenc, format_table
from pdum.rfb.encoders.nvenc import nvenc_available
from pdum.rfb.encoders.pyav_h264 import libx264_available


def test_image_benchmark_reports_sensible_numbers():
    r = benchmark_image(mode="jpeg", quality=80, frames=8, width=128, height=96, fps=30)
    assert r.frames == 8
    assert r.encode_ms_mean > 0
    assert r.bytes_per_frame > 0
    assert r.bitrate_at_fps_bps == pytest.approx(r.bytes_per_frame * 30 * 8)
    assert 10 < r.psnr_db < 80  # lossy but reasonable


def test_png_is_lossless():
    r = benchmark_image(mode="png", frames=4, width=64, height=64, fps=30)
    assert math.isinf(r.psnr_db)  # exact reconstruction


@pytest.mark.skipif(not libx264_available(), reason="libx264 (PyAV) not available")
def test_h264_benchmark_decodes_back_and_scores_quality():
    r = benchmark_h264(bitrate=4_000_000, frames=12, width=128, height=96, fps=30)
    assert r.encoder == "h264"
    assert r.encode_ms_mean > 0
    assert r.bytes_per_frame > 0
    assert r.psnr_db > 20  # decoded frames resemble the source


@pytest.mark.skipif(not nvenc_available(), reason="NVENC-capable GPU not available")
def test_nvenc_benchmark_decodes_back_and_scores_quality():
    r = benchmark_nvenc(bitrate=4_000_000, frames=12, width=256, height=192, fps=30)
    assert r.encoder == "nvenc"
    assert r.encode_ms_mean > 0
    assert r.bytes_per_frame > 0
    assert r.psnr_db > 20  # decoded frames resemble the source


def test_format_table_includes_a_header():
    r = benchmark_image(mode="jpeg", quality=50, frames=2, width=64, height=64, fps=30)
    table = format_table([r])
    assert "PSNR dB" in table
    assert "jpeg q50" in table
