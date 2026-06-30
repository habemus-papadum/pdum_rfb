"""Offline encoder benchmark: image vs CPU H.264 vs GPU NVENC, fully headless.

Encodes a deterministic synthetic pattern and reports, per configuration:

* encode time (mean and p95, milliseconds per frame),
* payload size (mean bytes per frame),
* the bitrate that size implies at a target frame rate,
* quality as PSNR in dB, measured by **decoding the output back** (Pillow for
  images, PyAV for H.264) and comparing to the source — so quality is real, not
  assumed.

Run it directly::

    uv run python -m pdum.rfb.benchmark --frames 120 --pattern gradient \\
        --sizes 640x480,1280x720 --h264-bitrate 2M,8M

This has no network and no browser; it is the quickest way to characterize the
software encoders.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from io import BytesIO
from time import perf_counter

import numpy as np

from .encoders.image import ImageEncoder
from .testing import render_pattern
from .types import RawFrame


@dataclass(slots=True)
class BenchmarkResult:
    label: str
    encoder: str
    width: int
    height: int
    frames: int
    fps: int
    encode_ms_mean: float
    encode_ms_p95: float
    bytes_per_frame: float
    bitrate_at_fps_bps: float
    psnr_db: float


def _psnr(a: np.ndarray, b: np.ndarray) -> float:
    """Peak signal-to-noise ratio in dB between two uint8 RGB arrays."""
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    mse = float(np.mean((a - b) ** 2))
    if mse <= 1e-12:
        return float("inf")
    return 10.0 * np.log10((255.0**2) / mse)


def _p95(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(np.percentile(values, 95))


def _source_frames(pattern: str, frames: int, width: int, height: int) -> list[np.ndarray]:
    return [np.ascontiguousarray(render_pattern(pattern, seq, width, height)) for seq in range(frames)]


def benchmark_image(
    *,
    mode: str = "jpeg",
    quality: int = 80,
    frames: int = 60,
    width: int = 640,
    height: int = 480,
    fps: int = 30,
    pattern: str = "gradient",
) -> BenchmarkResult:
    from PIL import Image

    src = _source_frames(pattern, frames, width, height)
    enc = ImageEncoder(mode=mode, quality=quality)  # type: ignore[arg-type]
    times: list[float] = []
    sizes: list[int] = []
    psnrs: list[float] = []
    for seq, arr in enumerate(src):
        t0 = perf_counter()
        payload = enc.encode(RawFrame(seq, width, height, seq * 1000, "rgb24", "cpu", arr))[0]
        times.append((perf_counter() - t0) * 1000)
        sizes.append(len(payload.payload))
        decoded = np.asarray(Image.open(BytesIO(payload.payload)).convert("RGB"))
        psnrs.append(_psnr(arr, decoded))

    bytes_per_frame = float(np.mean(sizes))
    return BenchmarkResult(
        label=f"{mode}{'' if mode == 'png' else f' q{quality}'}",
        encoder="image",
        width=width,
        height=height,
        frames=frames,
        fps=fps,
        encode_ms_mean=float(np.mean(times)),
        encode_ms_p95=_p95(times),
        bytes_per_frame=bytes_per_frame,
        bitrate_at_fps_bps=bytes_per_frame * fps * 8,
        psnr_db=float(np.mean([p for p in psnrs if np.isfinite(p)] or [float("inf")])),
    )


def _benchmark_video(
    *,
    make_encoder,
    label: str,
    encoder_name: str,
    frames: int,
    width: int,
    height: int,
    fps: int,
    pattern: str,
) -> BenchmarkResult:
    """Shared driver for the H.264 backends (libx264 / NVENC).

    ``make_encoder`` is a no-arg callable returning a fresh
    :class:`~pdum.rfb.types.EncoderBackend`; the bitstream is decoded back with
    PyAV to measure real PSNR.
    """
    from .testing import decode_annexb

    src = _source_frames(pattern, frames, width, height)
    enc = make_encoder()
    times: list[float] = []
    total_bytes = 0
    chunks: list[bytes] = []
    for seq, arr in enumerate(src):
        t0 = perf_counter()
        payloads = enc.encode(RawFrame(seq, width, height, seq * 1000, "rgb24", "cpu", arr), force_keyframe=(seq == 0))
        times.append((perf_counter() - t0) * 1000)
        for p in payloads:
            total_bytes += len(p.payload)
            chunks.append(p.payload)
    for p in enc.flush():
        total_bytes += len(p.payload)
        chunks.append(p.payload)
    enc.close()

    decoded = decode_annexb(b"".join(chunks))
    psnrs = [_psnr(src[i], f.to_ndarray(format="rgb24")) for i, f in enumerate(decoded[:frames])]

    bytes_per_frame = total_bytes / frames
    return BenchmarkResult(
        label=label,
        encoder=encoder_name,
        width=width,
        height=height,
        frames=frames,
        fps=fps,
        encode_ms_mean=float(np.mean(times)),
        encode_ms_p95=_p95(times),
        bytes_per_frame=bytes_per_frame,
        bitrate_at_fps_bps=bytes_per_frame * fps * 8,
        psnr_db=float(np.mean(psnrs)) if psnrs else float("nan"),
    )


def benchmark_h264(
    *,
    bitrate: int = 8_000_000,
    frames: int = 60,
    width: int = 640,
    height: int = 480,
    fps: int = 30,
    pattern: str = "gradient",
) -> BenchmarkResult:
    from .encoders.pyav_h264 import PyAvH264Encoder

    return _benchmark_video(
        make_encoder=lambda: PyAvH264Encoder(width=width, height=height, fps=fps, bitrate=bitrate),
        label=f"h264 {bitrate // 1_000_000}M",
        encoder_name="h264",
        frames=frames,
        width=width,
        height=height,
        fps=fps,
        pattern=pattern,
    )


def benchmark_nvenc(
    *,
    bitrate: int = 8_000_000,
    frames: int = 60,
    width: int = 640,
    height: int = 480,
    fps: int = 30,
    pattern: str = "gradient",
) -> BenchmarkResult:
    from time import sleep

    from .encoders.nvenc import NvencH264Encoder

    def make_encoder():
        # Consumer GPUs cap concurrent NVENC sessions; a fresh open can transiently
        # fail under churn, so retry a few times before giving up.
        last: Exception | None = None
        for _ in range(4):
            try:
                return NvencH264Encoder(width=width, height=height, fps=fps, bitrate=bitrate)
            except ValueError:
                raise  # width below the NVENC minimum is not transient
            except Exception as exc:  # pragma: no cover - hardware/driver dependent
                last = exc
                sleep(0.25)
        raise RuntimeError(f"NVENC encoder failed to open after retries: {last}")

    return _benchmark_video(
        make_encoder=make_encoder,
        label=f"nvenc {bitrate // 1_000_000}M",
        encoder_name="nvenc",
        frames=frames,
        width=width,
        height=height,
        fps=fps,
        pattern=pattern,
    )


def format_table(results: list[BenchmarkResult]) -> str:
    header = (
        f"{'config':<12}{'size':>10}{'fps':>5}{'enc ms':>9}{'p95 ms':>9}{'KB/frame':>10}{'Mbps@fps':>10}{'PSNR dB':>9}"
    )
    lines = [header, "-" * len(header)]
    for r in results:
        psnr = "  inf" if r.psnr_db == float("inf") else f"{r.psnr_db:6.2f}"
        lines.append(
            f"{r.label:<12}{f'{r.width}x{r.height}':>10}{r.fps:>5}{r.encode_ms_mean:>9.2f}{r.encode_ms_p95:>9.2f}"
            f"{r.bytes_per_frame / 1024:>10.1f}{r.bitrate_at_fps_bps / 1e6:>10.2f}{psnr:>9}"
        )
    return "\n".join(lines)


def _parse_bitrate(text: str) -> int:
    text = text.strip().lower()
    if text.endswith("m"):
        return int(float(text[:-1]) * 1_000_000)
    if text.endswith("k"):
        return int(float(text[:-1]) * 1_000)
    return int(text)


def _parse_size(text: str) -> tuple[int, int]:
    w, h = text.lower().split("x")
    return int(w), int(h)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Benchmark the image, CPU H.264, and GPU NVENC encoders")
    parser.add_argument("--frames", type=int, default=120)
    parser.add_argument("--fps", default="30", help="comma-separated frame rates, e.g. 15,30,60")
    parser.add_argument("--pattern", default="gradient")
    parser.add_argument("--sizes", default="640x480,1280x720")
    parser.add_argument("--jpeg-quality", default="50,80")
    parser.add_argument("--h264-bitrate", default="2M,8M")
    parser.add_argument("--nvenc-bitrate", default=None, help="defaults to --h264-bitrate")
    parser.add_argument("--no-h264", action="store_true")
    parser.add_argument("--no-nvenc", action="store_true", help="skip the GPU NVENC encoder")
    args = parser.parse_args(argv)

    from .encoders.nvenc import NVENC_MIN_WIDTH, nvenc_available
    from .encoders.pyav_h264 import libx264_available

    fps_values = [int(f) for f in args.fps.split(",")]
    use_h264 = not args.no_h264 and libx264_available()
    use_nvenc = not args.no_nvenc and nvenc_available()
    nvenc_bitrates = (args.nvenc_bitrate or args.h264_bitrate).split(",")

    results: list[BenchmarkResult] = []
    for size in args.sizes.split(","):
        w, h = _parse_size(size)
        for fps in fps_values:
            for q in args.jpeg_quality.split(","):
                results.append(
                    benchmark_image(
                        mode="jpeg",
                        quality=int(q),
                        frames=args.frames,
                        width=w,
                        height=h,
                        fps=fps,
                        pattern=args.pattern,
                    )
                )
            results.append(
                benchmark_image(mode="png", frames=args.frames, width=w, height=h, fps=fps, pattern=args.pattern)
            )
            if use_h264:
                for br in args.h264_bitrate.split(","):
                    results.append(
                        benchmark_h264(
                            bitrate=_parse_bitrate(br),
                            frames=args.frames,
                            width=w,
                            height=h,
                            fps=fps,
                            pattern=args.pattern,
                        )
                    )
            if use_nvenc and w >= NVENC_MIN_WIDTH:
                for br in nvenc_bitrates:
                    results.append(
                        benchmark_nvenc(
                            bitrate=_parse_bitrate(br),
                            frames=args.frames,
                            width=w,
                            height=h,
                            fps=fps,
                            pattern=args.pattern,
                        )
                    )

    note = ""
    if not args.no_nvenc and not nvenc_available():
        note = "  (NVENC unavailable on this host — GPU rows skipped)"
    print(f"pattern={args.pattern} frames={args.frames} fps={args.fps}{note}\n")
    print(format_table(results))


if __name__ == "__main__":
    main()
