"""Tests for the PyAV-free SDK NVENC backend (``pdum.nvenc`` / ``NvencGpuPdumEncoder``).

Focused on the **pipelined** (token-based seq attribution) path — the counterpart of
``test_vtenc.py``'s ``test_pipelined_*``. The whole module skips unless the SDK NVENC
path is actually usable on this box (``nvenc_gpu_pdum_available()``), so CI without an
NVENC GPU / the ``habemus-papadum-nvenc`` build stays green.

Unlike VideoToolbox, NVENC really pipelines: with ``extra_output_delay >= 2`` the encoder
buffers frames, so these tests additionally prove **max observed depth >= 1** — the proof
the token survives a genuinely deep pipeline (on VideoToolbox that depth is always 0).
"""

from __future__ import annotations

import pytest

from pdum.rfb.encoders.nvenc_gpu_pdum import nvenc_gpu_pdum_available
from pdum.rfb.testing import decode_annexb

pytestmark = pytest.mark.skipif(not nvenc_gpu_pdum_available(), reason="SDK NVENC (pdum.nvenc) not available")

W, H = 256, 192  # even, comfortably above NVENC_MIN_WIDTH


def _nv12(seq: int, width: int = W, height: int = H):
    """A contiguous CUDA NV12 ``(H + H//2, W)`` frame: moving luma, neutral chroma."""
    import cupy as cp

    nv12 = cp.empty((height + height // 2, width), cp.uint8)
    nv12[:height] = (seq * 7) % 256
    nv12[height:] = 128
    return nv12


# --- binding level (pdum.nvenc.NvencEncoder) -----------------------------------------


def test_nvenc_pipelined_recovers_seq_and_pipelines():
    """submit()/flush_pipeline() recover the seq in order with no loss, AND NVENC really
    buffers (max depth >= 1) — the throughput win the whole feature exists for."""
    import cupy as cp
    from pdum.nvenc import NvencEncoder

    n = 24
    enc = NvencEncoder(W, H, codec="h264", fps=30, gop=30, bitrate=6_000_000, extra_output_delay=3)
    seqs, keys, blob, emitted, max_depth = [], [], b"", 0, 0
    for seq in range(n):
        cp.cuda.runtime.deviceSynchronize()
        aus = enc.submit(_nv12(seq), seq, force_idr=(seq == 0))
        emitted += len(aus)
        max_depth = max(max_depth, (seq + 1) - emitted)
        for s, d, k in aus:
            assert isinstance(s, int) and isinstance(d, bytes) and isinstance(k, bool)
            seqs.append(s)
            keys.append(k)
            blob += d
    for s, d, k in enc.flush_pipeline():
        seqs.append(s)
        keys.append(k)
        blob += d
    enc.close()

    assert seqs == list(range(n)), f"recovered seqs must be 0..{n - 1} in order; got {seqs}"
    assert max_depth >= 1, "NVENC did not pipeline (depth 0) — expected buffering at extra_output_delay=3"
    assert keys[0] and not any(keys[1:]), "only frame 0 is a keyframe (gop=30 > n)"
    frames = decode_annexb(blob)
    assert len(frames) >= n - 3
    assert all(f.width == W and f.height == H for f in frames)


def test_nvenc_sync_encode_still_byte_stream_unchanged():
    """extra_output_delay=0 stays synchronous 1-in-1-out (encode()/flush() path)."""
    import cupy as cp
    from pdum.nvenc import NvencEncoder

    enc = NvencEncoder(W, H, codec="h264", fps=30, gop=30, bitrate=6_000_000)  # depth 0
    blob = b""
    for seq in range(8):
        cp.cuda.runtime.deviceSynchronize()
        blob += enc.encode(_nv12(seq), force_idr=(seq == 0))
    blob += enc.flush()
    enc.close()
    frames = decode_annexb(blob)
    assert len(frames) >= 6 and all(f.width == W and f.height == H for f in frames)


# --- rfb wrapper level (NvencGpuPdumEncoder) -----------------------------------------


def _cuda_frame(seq: int):
    from pdum.rfb.gpu import cuda_frame

    return cuda_frame(_nv12(seq), pixel_format="nv12", height=H, seq=seq)


def test_wrapper_pipeline_depth_recovers_seq():
    """The rfb wrapper in pipelined mode labels each payload with the recovered seq."""
    from pdum.rfb.encoders.nvenc_gpu_pdum import NvencGpuPdumEncoder

    n = 20
    enc = NvencGpuPdumEncoder(width=W, height=H, fps=20, bitrate=6_000_000, pipeline_depth=2)
    seqs, blob = [], b""
    for i in range(n):
        for p in enc.encode(_cuda_frame(i), force_keyframe=(i == 0)):
            seqs.append(p.seq)
            blob += p.payload
            assert p.metadata["bitstream"] == "annexb" and p.metadata["encoder"] == "nvenc-gpu-pdum"
    for p in enc.flush():
        seqs.append(p.seq)
        blob += p.payload
    enc.close()
    assert seqs == list(range(n)), f"payload seqs must be recovered tokens; got {seqs}"
    assert len(decode_annexb(blob)) >= n - 3


def test_wrapper_recovers_seq_through_dropped_frames():
    """Latest-frame-wins drops frames *before* submit(), so the seqs reaching the encoder
    have gaps. The recovered payload seqs must be exactly the submitted (gappy) seqs, in
    order — the case a naive internal-counter would mislabel."""
    from pdum.rfb.encoders.nvenc_gpu_pdum import NvencGpuPdumEncoder

    submitted = [0, 1, 2, 5, 6, 9, 10, 11, 14, 15, 18, 21, 22]  # monotonic, with gaps
    enc = NvencGpuPdumEncoder(width=W, height=H, fps=20, bitrate=6_000_000, pipeline_depth=2)
    seqs, blob = [], b""
    for i, seq in enumerate(submitted):
        frame = _cuda_frame(seq)
        for p in enc.encode(frame, force_keyframe=(i == 0)):
            seqs.append(p.seq)
            blob += p.payload
    for p in enc.flush():
        seqs.append(p.seq)
        blob += p.payload
    enc.close()
    assert seqs == submitted, f"recovered seqs must match the submitted (gappy) seqs; got {seqs}"
    assert len(decode_annexb(blob)) >= len(submitted) - 3


def test_build_encoder_threads_pipeline_depth_to_nvenc_gpu_pdum():
    """serve(encode_pipeline_depth=)'s plumbing: build_encoder forwards it to the wrapper."""
    from pdum.rfb.encoders.base import build_encoder
    from pdum.rfb.encoders.nvenc_gpu_pdum import NvencGpuPdumEncoder
    from pdum.rfb.protocol import DEFAULT_H264_CODEC, BackendSelection

    selection = BackendSelection(transport="h264", codec=DEFAULT_H264_CODEC)
    enc = build_encoder(selection, width=W, height=H, fps=30, video_encoder="nvenc_gpu_pdum", pipeline_depth=2)
    assert isinstance(enc, NvencGpuPdumEncoder) and enc.pipeline_depth == 2
    enc.close()


def test_pipeline_depth_zero_is_synchronous_default():
    """pipeline_depth defaults to 0 (synchronous), and negative is clamped to 0."""
    from pdum.rfb.encoders.nvenc_gpu_pdum import NvencGpuPdumEncoder

    # Negative clamps to 0; close it before opening the next (consumer GPUs cap sessions).
    neg = NvencGpuPdumEncoder(width=W, height=H, fps=20, pipeline_depth=-4)
    assert neg.pipeline_depth == 0
    neg.close()

    enc = NvencGpuPdumEncoder(width=W, height=H, fps=20)
    assert enc.pipeline_depth == 0
    # A synchronous forced-IDR still returns exactly one payload for its own frame.
    payloads = enc.encode(_cuda_frame(0), force_keyframe=True)
    enc.close()
    assert len(payloads) == 1 and payloads[0].seq == 0 and payloads[0].keyframe
