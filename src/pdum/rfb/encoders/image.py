"""Image encoder: JPEG / PNG / WebP via Pillow.

The simplest backend (guide section 5). Every image is an independent frame, so
every payload is a keyframe. Ideal for snapshots, debug views, low/medium frame
rates, and mostly static plots.
"""

from __future__ import annotations

from io import BytesIO
from typing import Literal

import numpy as np
from PIL import Image

from ..protocol import CAP_JPEG, CAP_PNG, CAP_WEBP
from ..types import EncodedPayload, RawFrame

ImageMode = Literal["jpeg", "png", "webp"]


class ImageEncoder:
    """Encode CPU RGB/RGBA frames to JPEG, PNG or WebP."""

    def __init__(self, *, mode: ImageMode = "jpeg", quality: int = 80) -> None:
        self.mode: ImageMode = mode
        self.quality = quality

    def encode(self, frame: RawFrame, *, force_keyframe: bool = False) -> list[EncodedPayload]:
        if frame.memory != "cpu":
            raise TypeError("ImageEncoder expects CPU frames")

        arr = frame.data
        if not isinstance(arr, np.ndarray):
            raise TypeError("Expected numpy.ndarray")

        if frame.pixel_format == "rgb24":
            img = Image.fromarray(arr, "RGB")
        elif frame.pixel_format == "rgba8":
            img = Image.fromarray(arr, "RGBA")
        else:
            raise ValueError(f"Unsupported pixel format for image encoder: {frame.pixel_format}")

        out = BytesIO()
        if self.mode == "jpeg":
            if img.mode == "RGBA":  # JPEG cannot store alpha.
                img = img.convert("RGB")
            img.save(out, format="JPEG", quality=self.quality, optimize=False)
            mime = CAP_JPEG
        elif self.mode == "png":
            img.save(out, format="PNG")
            mime = CAP_PNG
        elif self.mode == "webp":
            img.save(out, format="WEBP", quality=self.quality)
            mime = CAP_WEBP
        else:  # pragma: no cover - guarded by the Literal type
            raise ValueError(self.mode)

        return [
            EncodedPayload(
                seq=frame.seq,
                kind="image",
                timestamp_us=frame.timestamp_us,
                width=frame.width,
                height=frame.height,
                mime=mime,
                payload=out.getvalue(),
                keyframe=True,
            )
        ]

    def flush(self) -> list[EncodedPayload]:
        return []

    def close(self) -> None:
        pass
