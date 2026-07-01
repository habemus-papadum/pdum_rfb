"""Encoder-only throughput: synchronous ``encode()`` vs pipelined ``submit()`` on NVENC.

The NVENC counterpart of ``mlx_vt_bench.py --compare-pipeline``. It feeds the SAME prebuilt
CUDA NV12 frame through the ``pdum.nvenc`` SDK encoder, differing only in ``encode()``
(synchronous 1-in-1-out) vs ``submit()`` (pipelined, ``extra_output_delay = depth``), and
reports sustained encoder-only fps plus the max observed pipeline depth (submitted − emitted).

Where VideoToolbox's low-latency RC keeps depth ~0 (pipelining a no-op), NVENC genuinely
buffers, so the pipelined column runs faster. This is the measurement behind the "NVENC —
where it pays off" table in ``docs/pipelined_encode.md``.

Run (needs an NVENC GPU + the gpu-nvenc-sdk extra)::

    RFB_GPU=force uv sync --extra gpu-nvenc-sdk
    uv run python examples/nvenc_pipeline_bench.py
    uv run python examples/nvenc_pipeline_bench.py --fps 60 --frames 600 --depth 4
"""

from __future__ import annotations

import argparse
import time


def encoder_only_fps(width, height, fps, frames, warmup, depth) -> tuple[float, int]:
    """Sustained encoder-only fps for one path. ``depth == 0`` uses the synchronous
    ``encode()``; ``depth > 0`` uses the pipelined ``submit()`` at ``extra_output_delay=depth``.
    Returns (fps, max_observed_depth). Mirrors ``mlx_vt_bench.encoder_only_fps``."""
    import cupy as cp
    from pdum.nvenc import NvencEncoder

    bitrate = max(4_000_000, width * height * fps // 20)
    enc = NvencEncoder(width, height, codec="h264", fps=fps, gop=fps, bitrate=bitrate, extra_output_delay=depth)
    nv12 = cp.zeros((height + height // 2, width), cp.uint8)
    nv12[height:] = 128
    emitted, max_depth, t0 = 0, 0, None
    for i in range(warmup + frames):
        if i == warmup:
            cp.cuda.runtime.deviceSynchronize()
            t0 = time.perf_counter()
        nv12[:height] = (i * 7) % 200 + 16  # moving luma so there is real work to encode
        cp.cuda.runtime.deviceSynchronize()  # NV12 ready before NVENC's copy (as the wrapper does)
        if depth > 0:
            emitted += len(enc.submit(nv12, seq=i, force_idr=(i == 0)))
        else:
            enc.encode(nv12, force_idr=(i == 0))
            emitted += 1
        if i >= warmup:
            max_depth = max(max_depth, (i + 1) - emitted)
    wall = time.perf_counter() - t0
    if depth > 0:
        enc.flush_pipeline()
    else:
        enc.flush()
    enc.close()
    return frames / wall, max_depth


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--warmup", type=int, default=30)
    ap.add_argument("--depth", type=int, default=4, help="pipelined extra_output_delay to compare against sync")
    args = ap.parse_args()

    sizes = [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)]
    print(
        f"NVENC encoder-only throughput, sync encode() vs pipelined submit() "
        f"(same CUDA NV12 input; {args.frames} frames + {args.warmup} warmup, fps={args.fps}, depth={args.depth}):"
    )
    print(f"{'size':>10} {'sync fps':>10} {'pipe fps':>10} {'speedup':>9} {'max depth':>10}")
    for w, h in sizes:
        sync_fps, _ = encoder_only_fps(w, h, args.fps, args.frames, args.warmup, depth=0)
        pipe_fps, depth = encoder_only_fps(w, h, args.fps, args.frames, args.warmup, depth=args.depth)
        print(f"{f'{w}x{h}':>10} {sync_fps:>10.1f} {pipe_fps:>10.1f} {pipe_fps / sync_fps:>8.2f}x {depth:>10}")


if __name__ == "__main__":
    main()
