# Performance

Per-frame **encode** numbers for every path, measured on one box with the built-in
benchmark. Use them to choose an encoder (see [Installation](installation.md)) and to
sanity-check your own hardware with `pdum-rfb benchmark`.

## Test box

| | |
| --- | --- |
| GPU | NVIDIA GeForce RTX 4090 Laptop GPU |
| Driver | 580.159.04 |
| OS / Python | Linux (Ubuntu 24.04) · CPython 3.14.6 |
| Pattern / frames | `gradient`, 120 frames, 30 fps, 10 Mbps target (H.264) |
| Tool | `pdum-rfb benchmark` (wraps `python -m pdum.rfb.benchmark`) |

"enc ms" is mean wall-clock per `encode()` call. For the GPU-resident rows
(`nvenc-gpu-pyav`, `nvenc-gpu-pdum`) it covers the on-GPU RGB→NV12 conversion **and** the
encode, with `cudaDeviceSynchronize()` on both sides — the realistic
"everything-on-GPU" cost. For `nvenc-cpu` (host) it covers the CPU `rgb→yuv` reformat +
PCIe upload + encode, i.e. what you pay when frames originate on the CPU. PSNR is
measured by decoding the bitstream back (Pillow / PyAV) and comparing to the source.

## Headline — 1920×1080

| Path | enc ms | p95 ms | KB/frame | Mbps@30 | PSNR dB | Notes |
| ---- | -----: | -----: | -------: | ------: | ------: | ----- |
| `nvenc-gpu-pdum` (SDK, GPU) | **2.02** | 2.21 | 32.7 | 8.03 | 44.30 | NVENC SDK; no PyAV |
| `nvenc-gpu-pyav` (PyAV 18, GPU) | 3.08 | 3.30 | 34.4 | 8.45 | 43.61 | zero-copy via ffmpeg |
| `h264-cpu` (libx264, CPU) | 5.39 | 6.19 | 40.9 | 10.06 | 44.18 | software |
| `nvenc-cpu` (PyAV, host) | 9.20 | 9.12 | 34.4 | 8.44 | 43.66 | CPU reformat + upload |
| `jpeg q80` (image) | 3.63 | 3.94 | 91.2 | 22.41 | 34.31 | image-per-frame |

Both GPU-resident paths beat everything else; the **SDK path is fastest** (less
per-frame overhead than routing through ffmpeg's `h264_nvenc`). The host `nvenc-cpu` row
is *slower* than CPU libx264 here — that's the CPU `rgb→yuv` + PCIe upload tax, which
the GPU-resident paths skip entirely. Image-per-frame is fast to encode but an order
of magnitude larger on the wire at much lower quality.

## Encode latency vs resolution (ms/frame)

| Path | 1280×720 | 1920×1080 | 2560×1440 | 3840×2160 |
| ---- | -------: | --------: | --------: | --------: |
| `nvenc-gpu-pdum` (SDK, GPU) | **1.06** | **2.02** | **2.79** | **5.31** |
| `nvenc-gpu-pyav` (PyAV 18, GPU) | 1.93 | 3.08 | 3.84 | 7.53 |
| `h264-cpu` (libx264, CPU) | 3.71 | 5.39 | 9.07 | 16.22 |
| `jpeg q80` (image) | 2.02 | 3.63 | 6.68 | 15.88 |
| `nvenc-cpu` (PyAV, host) | 6.16 | 9.20 | 14.40 | 30.29 |

The GPU-resident paths scale far better: at **4K** the SDK path is **5.3 ms** (≈188
fps headroom) versus **30 ms** for host NVENC and **16 ms** for CPU libx264. The host
path degrades fastest because the single-threaded libswscale `rgb→yuv` reformat and
the PCIe upload both grow with pixel count.

## Takeaways

- **Rendering on the GPU?** Use a GPU-resident path and keep frames on the device.
  The **`nvenc-gpu-pdum`** path is the fastest measured here and the easiest to install
  (a prebuilt wheel, no PyAV-18 build) — it's what `pdum-rfb doctor` recommends.
- **`nvenc-gpu-pyav` (PyAV 18)** reaches nearly the same speed if you prefer the
  PyAV/ffmpeg stack; the gap is per-frame wrapper overhead, not the encode itself.
- **Frames originate on the CPU?** `h264-cpu` (libx264) is the portable choice and often
  beats *host* NVENC once you count the reformat + upload. Reach for host `nvenc-cpu`
  mainly to offload the CPU, not for latency.
- **Image path** is for stills/snapshots and the lossless-final still, not motion.

## Reproduce

```bash
pip install 'habemus-papadum-rfb[cli]'
pdum-rfb doctor                 # what's available + the recommended path
pdum-rfb benchmark --sizes 1280x720,1920x1080,2560x1440,3840x2160 --bitrate 10M
```

`doctor` on the test box:

```
 Component                                        Status   Detail
 Python                                           ✓ ok     3.14.6 (need ≥3.14)
 h264-cpu — CPU H.264 (libx264)                   ✓ ok     libx264 present
 nvenc-cpu — host NVENC (PyAV h264_nvenc)         ✓ ok     available
 nvenc-gpu-pyav — zero-copy CUDA→NVENC (PyAV≥18)  ✓ ok     available   # PyAV-18 venv only
 nvenc-gpu-pdum — NVENC SDK (pdum.nvenc)          ✓ ok     available (no PyAV needed)
 → Recommended: nvenc-gpu-pdum — NVENC SDK (pdum.nvenc): fastest GPU path, no PyAV
```

`benchmark` auto-detects what's installed: the `nvenc-gpu-pyav` row appears only with
PyAV ≥ 18, and `nvenc-gpu-pdum` only with the `habemus-papadum-nvenc` package.

## Methodology notes & caveats

- **The `nvenc-gpu-pyav` (PyAV 18) row was measured in a separate, throwaway venv** built
  with `scripts/install-gpu.sh` (PyAV 18.0.0rc0 from source). The project's own venv
  stays on PyAV 17.1 on purpose, so this number does not come from the dev env; it
  was produced with the identical `benchmark_nvenc_gpu_pyav` harness at the same
  settings and is directly comparable to the other rows.
- Encoder configs are *close* but not byte-identical across paths (preset/tuning
  differ between the SDK binding and PyAV's `h264_nvenc`), so treat small PSNR/size
  differences as noise; the **latency** ranking is the robust result.
- Consumer GPUs cap concurrent NVENC sessions and can transiently stall under rapid
  session open/close; production uses one long-lived encoder. Numbers are
  steady-state over 120 frames after a forced IDR on frame 0.
- These `nvenc-gpu-pdum` figures are the **default zero-latency** path (`extra_output_delay=0`:
  each frame's access unit returns from its own `encode()`, no pipeline overlap), so they are
  honest end-to-end latency, not a pipelined best case. Measured ~2.3 ms at 1080p here — still
  the fastest path. Opting into `serve(encode_pipeline_depth=k>0)` trades `k/fps` of latency
  for higher sustained throughput (≈1.2× at 1080p, up to ~1.5× at 720p; see the measured table
  in [Pipelined encode](pipelined_encode.md#nvenc-linuxcuda-where-it-pays-off)). The default
  stays `0` for the interactive, latest-frame-wins use case.
- Synthetic `gradient` pattern; real scenes change bitrate/PSNR but not the latency
  ordering. Bitrate is a 10 Mbps VBR target.
- See [Zero-copy CUDA→NVENC](gpu_zerocopy.md) and the
  [NVENC SDK evaluation](proposals/completed/nvenc_sdk_evaluation.md) for the architecture behind the two
  GPU rows.
