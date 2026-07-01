"""Benchmark the MLX → VideoToolbox path, per stage, across resolutions.

The question this answers: on Apple-Silicon unified memory, **is the host-NV12 → CVPixelBuffer
copy in `VtEncoder` worth eliminating** (the "zero-copy" milestone)? It times each stage with
GPU sync so the input-copy cost can be compared against the actual HW encode and the MLX
render/convert kernels — and reports sustained fps so the synchronous-1-in-1-out encode
latency is visible too.

    uv sync --extra mac-vt --group mac-dev
    uv run python examples/mlx_vt_bench.py                 # default resolution sweep
    uv run python examples/mlx_vt_bench.py --frames 120
    uv run python examples/mlx_vt_bench.py --width 1920 --height 1080

Stages (per frame):
  render     MLX custom Metal kernel renders RGBA            (GPU, mx.eval-synced)
  convert    MLX custom Metal kernel RGBA -> NV12 (BT.601)   (GPU, mx.eval-synced)
  copy       host NV12 -> CVPixelBuffer memcpy               (VtEncoder.last_copy_ms)
  vt_encode  VTCompressionSessionEncodeFrame + CompleteFrames (VtEncoder.last_encode_ms)
  encode()   the whole VtEncoder.encode() call wall time     (copy + vt_encode + packetize)
"""

from __future__ import annotations

import argparse
import statistics
import time

import mlx.core as mx
import numpy as np

# Reuse the two custom Metal kernels from the streaming example (no duplication).
from mlx_vt_stream import render_rgba, rgba_to_nv12

DEFAULT_SIZES = [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)]


def bench_one(width: int, height: int, fps: int, frames: int, warmup: int) -> dict:
    from pdum.vtenc import VtEncoder

    bitrate = max(4_000_000, width * height * fps // 20)
    enc = VtEncoder(width, height, fps=fps, gop=fps, bitrate=bitrate)

    render_ms, convert_ms, encode_call_ms, copy_ms, vt_ms = [], [], [], [], []
    total_wall = 0.0
    n = warmup + frames
    for i in range(n):
        t0 = time.perf_counter()
        rgba = render_rgba(i / fps, width, height)
        mx.eval(rgba)
        t1 = time.perf_counter()
        nv12 = rgba_to_nv12(rgba, width, height)
        mx.eval(nv12)
        t2 = time.perf_counter()
        enc.encode(nv12, force_idr=(i == 0))
        t3 = time.perf_counter()
        if i >= warmup:  # drop warmup frames (first-frame alloc/ kernel-compile / IDR)
            render_ms.append((t1 - t0) * 1000)
            convert_ms.append((t2 - t1) * 1000)
            encode_call_ms.append((t3 - t2) * 1000)
            copy_ms.append(enc.last_copy_ms)
            vt_ms.append(enc.last_encode_ms)
            total_wall += t3 - t0
    codec = enc.codec_string
    enc.close()

    mean = lambda xs: statistics.mean(xs)  # noqa: E731
    return {
        "size": f"{width}x{height}",
        "codec": codec,
        "render": mean(render_ms),
        "convert": mean(convert_ms),
        "copy": mean(copy_ms),
        "vt_encode": mean(vt_ms),
        "encode_call": mean(encode_call_ms),
        "fps": frames / total_wall if total_wall else float("nan"),
        "copy_pct": 100 * mean(copy_ms) / mean(encode_call_ms) if mean(encode_call_ms) else 0.0,
    }


def encoder_only_fps(width: int, height: int, fps: int, frames: int, warmup: int, pipelined: bool) -> tuple[float, int]:
    """Sustained encoder-only fps (no MLX): the SAME prebuilt NV12 loop, differing only in
    encode() (synchronous) vs submit() (pipelined). Apples-to-apples isolation of the encoder
    path. Also reports the max observed pipeline depth (submitted - emitted). On VideoToolbox
    depth stays ~0 (low-latency RC is synchronous) and the two fps match — the point of the
    comparison: pipelining is a no-op on VT (it pays off on NVENC)."""
    from pdum.vtenc import VtEncoder

    bitrate = max(4_000_000, width * height * fps // 20)
    enc = VtEncoder(width, height, fps=fps, gop=fps, bitrate=bitrate)
    nv12 = np.zeros((height + height // 2, width), np.uint8)
    nv12[height:] = 128
    emitted, max_depth, t0 = 0, 0, None
    for i in range(warmup + frames):
        if i == warmup:
            t0 = time.perf_counter()
        nv12[:height] = (i * 7) % 200 + 16
        if pipelined:
            emitted += len(enc.submit(nv12, seq=i, force_idr=(i == 0)))
        else:
            enc.encode(nv12, force_idr=(i == 0))
            emitted += 1
        if i >= warmup:
            max_depth = max(max_depth, (i + 1) - emitted)
    wall = time.perf_counter() - t0
    if pipelined:
        enc.flush_pipeline()
    enc.close()
    return frames / wall, max_depth


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--warmup", type=int, default=10)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--width", type=int, default=None)
    ap.add_argument("--height", type=int, default=None)
    ap.add_argument(
        "--compare-pipeline",
        action="store_true",
        help="also measure the pipelined submit() path and compare throughput vs sync encode()",
    )
    args = ap.parse_args()

    sizes = [(args.width, args.height)] if args.width and args.height else DEFAULT_SIZES

    print(f"MLX → VideoToolbox per-stage benchmark  ({args.frames} frames + {args.warmup} warmup, fps={args.fps})")
    print(f"  device: {mx.default_device()}")
    cols = ("size", "codec", "render", "convert", "copy", "vt_enc", "encode()", "copy%", "fps")
    widths = (10, 12, 8, 8, 8, 8, 9, 7, 7)
    hdr = " ".join(f"{c:>{w}}" for c, w in zip(cols, widths))
    print(hdr)
    print("-" * len(hdr))
    for w, h in sizes:
        r = bench_one(w, h, args.fps, args.frames, args.warmup)
        print(
            f"{r['size']:>10} {r['codec']:>12} {r['render']:>8.3f} {r['convert']:>8.3f} "
            f"{r['copy']:>8.3f} {r['vt_encode']:>8.3f} {r['encode_call']:>9.3f} "
            f"{r['copy_pct']:>6.2f}% {r['fps']:>7.1f}"
        )
    print("\n(ms per stage. copy% = copy / encode(). All on unified memory — no PCIe transfer.)")

    if args.compare_pipeline:
        print("\nEncoder-only throughput, sync encode() vs pipelined submit() (same NV12 input, no MLX):")
        print(f"{'size':>10} {'sync fps':>10} {'pipe fps':>10} {'speedup':>9} {'max depth':>10}")
        for w, h in sizes:
            sync_fps, _ = encoder_only_fps(w, h, args.fps, args.frames, args.warmup, pipelined=False)
            pipe_fps, depth = encoder_only_fps(w, h, args.fps, args.frames, args.warmup, pipelined=True)
            print(f"{f'{w}x{h}':>10} {sync_fps:>10.1f} {pipe_fps:>10.1f} {pipe_fps / sync_fps:>8.2f}x {depth:>10}")
        print("(VideoToolbox low-latency RC is synchronous → depth ~0, ~1.0x. The knob pays off on NVENC.)")


if __name__ == "__main__":
    main()
