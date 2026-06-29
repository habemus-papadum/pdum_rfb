"""Encoder backends for the remote framebuffer."""

from __future__ import annotations

from .base import available_video_encoders, build_encoder, register_video_encoder
from .image import ImageEncoder

__all__ = [
    "ImageEncoder",
    "available_video_encoders",
    "build_encoder",
    "register_video_encoder",
]
