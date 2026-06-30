"""End-to-end MLX → VideoToolbox H.264, proving the macOS GPU encode path.

MLX custom Metal kernels generate frames on the GPU (Apple-Silicon unified memory); an
MLX kernel converts RGBA → NV12 (BT.601 limited range, the analog of
``pdum.rfb.gpu.rgb_to_nv12``); the NV12 array is handed straight to
``pdum.vtenc.VtEncoder`` (zero host copy — MLX arrays expose the buffer protocol), which
returns H.264 **Annex B**. The stream is decoded back with PyAV to prove validity.

This is the standalone-package end-to-end (``pdum.rfb`` ``serve()``/``publish()`` wiring
is a separate, deferred step). Needs the ``mac-vt`` extra (``pdum.vtenc``) and the
``mac-dev`` group (``mlx``)::

    uv sync --extra mac-vt --group mac-dev
    uv run python examples/mlx_vt_stream.py --check          # headless verify
    uv run python examples/mlx_vt_stream.py --out scene.h264 # also write a playable file
"""

from __future__ import annotations

import argparse

import mlx.core as mx
import numpy as np

# Two custom Metal kernels. Built once; the per-frame W/H are passed as template ints and
# the animation time as a 1-element input array, so the same kernels serve any resolution.

_render_kernel = mx.fast.metal_kernel(
    name="render_rgba",
    input_names=["t"],
    output_names=["out"],
    source="""
        uint x = thread_position_in_grid.x;
        uint y = thread_position_in_grid.y;
        if (x >= W || y >= H) return;
        uint idx = (y * W + x) * 4;
        // moving diagonal bands over an x/y gradient — high-entropy, obviously non-uniform
        float band = 0.5f + 0.5f * sin(0.05f * float(x + y) + t[0]);
        out[idx + 0] = (uint8_t)(255.0f * float(x) / float(W));
        out[idx + 1] = (uint8_t)(255.0f * float(y) / float(H) * band);
        out[idx + 2] = (uint8_t)(128.0f + 127.0f * sin(t[0]));
        out[idx + 3] = (uint8_t)255;
    """,
)

_nv12_kernel = mx.fast.metal_kernel(
    name="rgb_to_nv12",
    input_names=["rgb"],
    output_names=["out"],
    source="""
        uint x = thread_position_in_grid.x;
        uint y = thread_position_in_grid.y;
        if (x >= W || y >= H) return;
        uint ri = (y * W + x) * 4;
        float r = float(rgb[ri + 0]);
        float g = float(rgb[ri + 1]);
        float b = float(rgb[ri + 2]);
        // BT.601 limited range (matches pdum.rfb.gpu.rgb_to_nv12)
        out[y * W + x] = (uint8_t)clamp(0.257f * r + 0.504f * g + 0.098f * b + 16.0f, 0.0f, 255.0f);
        if ((x % 2u == 0u) && (y % 2u == 0u)) {
            float U = -0.148f * r - 0.291f * g + 0.439f * b + 128.0f;
            float V =  0.439f * r - 0.368f * g - 0.071f * b + 128.0f;
            uint uv = W * H + (y / 2u) * W + (x / 2u) * 2u;  // contiguous NV12 UV plane
            out[uv + 0] = (uint8_t)clamp(U, 0.0f, 255.0f);
            out[uv + 1] = (uint8_t)clamp(V, 0.0f, 255.0f);
        }
    """,
)


def render_rgba(t: float, w: int, h: int) -> mx.array:
    (out,) = _render_kernel(
        inputs=[mx.array([t], dtype=mx.float32)],
        template=[("W", w), ("H", h)],
        grid=(w, h, 1),
        threadgroup=(16, 16, 1),
        output_shapes=[(h, w, 4)],
        output_dtypes=[mx.uint8],
    )
    return out


def rgba_to_nv12(rgba: mx.array, w: int, h: int) -> mx.array:
    (out,) = _nv12_kernel(
        inputs=[rgba],
        template=[("W", w), ("H", h)],
        grid=(w, h, 1),
        threadgroup=(16, 16, 1),
        output_shapes=[(h + h // 2, w)],
        output_dtypes=[mx.uint8],
    )
    return out


def run(width: int, height: int, fps: int, frames: int, out: str | None) -> None:
    from pdum.vtenc import VtEncoder

    enc = VtEncoder(width, height, fps=fps, gop=fps, bitrate=10_000_000)
    stream = bytearray()
    for i in range(frames):
        rgba = render_rgba(i / fps, width, height)  # render on GPU
        nv12 = rgba_to_nv12(rgba, width, height)  # convert on GPU
        mx.eval(nv12)  # MLX is lazy — materialize before the encoder reads the buffer
        stream += enc.encode(nv12, force_idr=(i == 0))  # MLX array -> buffer protocol, no host copy
    codec = enc.codec_string
    stream += enc.flush()
    enc.close()
    stream = bytes(stream)

    # Verify the bitstream round-trips entirely in Python (PyAV's bundled ffmpeg).
    from pdum.rfb.testing import decode_annexb, has_sps_pps_idr, starts_with_start_code

    decoded = decode_annexb(stream)
    assert starts_with_start_code(stream), "not Annex B"
    assert has_sps_pps_idr(stream), "missing SPS/PPS/IDR"
    assert decoded, "decoded nothing"
    assert all(f.width == width and f.height == height for f in decoded), "wrong dimensions"
    rgb0 = decoded[0].to_ndarray(format="rgb24")
    assert len(np.unique(rgb0.reshape(-1, 3), axis=0)) > 1, "decoded frame is uniform"

    print(
        f"OK: MLX rendered {frames}×{width}×{height} → VideoToolbox {codec} → "
        f"{len(stream)} bytes Annex B → PyAV decoded {len(decoded)} frames "
        f"({len(stream) / max(frames, 1):.0f} bytes/frame)"
    )
    if out:
        with open(out, "wb") as f:
            f.write(stream)
        print(f"wrote {out}  (play with: ffplay {out})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--check", action="store_true", help="headless: render+encode+decode-back, no file")
    ap.add_argument("--out", default=None, help="write the H.264 elementary stream to this path")
    args = ap.parse_args()
    run(args.width, args.height, args.fps, args.frames, None if args.check else (args.out or "mlx_vt.h264"))
