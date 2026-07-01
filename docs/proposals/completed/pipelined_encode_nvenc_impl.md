# Pipelined encode — NVENC (implementation notes)

> **Status: IMPLEMENTED** (RTX 4090 Laptop, CUDA 13). This began as a build-it guide for a
> Linux/CUDA agent; it now records what actually landed. `NvencEncoder.submit()` /
> `flush_pipeline()`, `NvencGpuPdumEncoder(pipeline_depth=…)`, the factory forward, tests
> (`tests/test_nvenc_gpu_pdum.py`), and a benchmark (`examples/nvenc_pipeline_bench.py`,
> ≈1.2× at 1080p, ~1.5× at 720p) are all in. Measured results:
> [`pipelined_encode.md`](../../pipelined_encode.md#nvenc-linuxcuda-where-it-pays-off).

NVENC is the backend the pipelined-encode feature (see
[`pipelined_encode.md`](../../pipelined_encode.md)) exists for: `extra_output_delay > 0` keeps
several frames in flight and overlaps encode with render/convert. VideoToolbox — the reference
this mirrored — gains nothing (its low-latency RC is synchronous); NVENC gains a real throughput
increase. Everything above the `EncoderBackend` seam was already done (the session books each
`payload.seq`, and `build_encoder(…, pipeline_depth=)` / `serve(encode_pipeline_depth=)` already
threaded the knob), so this was two layers plus one factory line.

## What landed

| Layer | VideoToolbox (reference) | NVENC (this) |
| --- | --- | --- |
| Native binding | `packages/vtenc/src/cpp/vtenc_ext.mm` | `packages/nvenc/src/cpp/nvenc_ext.cpp` — `submit()` / `flush_pipeline()` returning `list[(seq, annexb, keyframe)]`; `encode()` / `flush()` byte-unchanged |
| rfb wrapper | `encoders/vtenc.py` `VideoToolboxEncoder` | `encoders/nvenc_gpu_pdum.py` `NvencGpuPdumEncoder(pipeline_depth=…)` → `extra_output_delay` |
| Factory | `_vtenc_factory` | `_nvenc_gpu_pdum_factory` (now forwards `pipeline_depth`) |
| Tests | `tests/test_vtenc.py` | `tests/test_nvenc_gpu_pdum.py` |
| Benchmark | `examples/mlx_vt_bench.py --compare-pipeline` | `examples/nvenc_pipeline_bench.py` |

The pipelined `submit()` returns `list[(recovered_seq, annexb, keyframe)]` (0..N tuples, output
order == input order, no B-frames), and the wrapper stamps each payload with the **recovered**
seq — not the call's `frame.seq` — looking the original `timestamp_us` up from a small
`{seq: timestamp_us}` in-flight map. `keyframe` comes straight from NVENC's `pictureType`.

## Seq recovery: in-order FIFO, not `inputTimeStamp`

The plan was to carry `seq` on `NV_ENC_PIC_PARAMS.inputTimeStamp` and read it back on
`NvEncOutputFrame.timeStamp`. That does **not** survive NVIDIA's vendored helper:
`NvEncoder::DoEncode` overwrites `inputTimeStamp` with its own counter
(`NvEncoder_130.cpp:690` / `_121.cpp:653`), and `packages/nvenc/third_party/` is kept verbatim.
Because `frameIntervalP=1` (no B-frames) forces output order == input order, the binding instead
pushes each `seq` onto a FIFO (`m_pending_seqs`) at `submit()` and pops it per output AU in
`tag()` — equivalent, and independent of the SDK's internal timestamp. This was a deliberate
choice over patching the vendored code (which its MIT license would permit): the FIFO relies
only on the no-B-frame ordering the whole system already guarantees, with no build machinery.

## Notes worth keeping

- **The reusable `self._nv12` staging buffer is safe under pipelining.** `CopyToDeviceFrame`
  copies it into NVENC's own input ring slot inside `submit()` before returning, so it is free
  to overwrite afterward — *provided the copy has completed*, which is why the
  `deviceSynchronize()` in `encode()` stays. The pure-CUDA-NV12 input path (no `rgb_to_nv12`, no
  staging buffer) is the cleanest case.
- **No session / protocol / browser changes.** The session books `payload.seq` from whatever the
  wrapper returns, so recovered-seq payloads "just work": `inflight`, `_send_times[seq]` (RTT),
  and the `displayed:true` FIFO all key on `seq`. Latest-frame-wins still drops *before*
  `submit()`, so the encoder pipeline only ever holds a valid reference chain; `max_inflight`
  bounds the wire independent of encoder depth. See
  [`internals.md`](../../internals.md#pipelined-encode-token-based-seq-attribution).
- **The binding also accepts host NV12** (a numpy `__array_interface__` array), copied via
  `CU_MEMORYTYPE_HOST` — a convenience so `pdum.nvenc` can be driven directly, without CuPy to
  feed it.

## Build & verify

```bash
RFB_GPU=force uv sync --extra gpu-nvenc-sdk
# After editing nvenc_ext.cpp, force a rebuild (uv caches the editable build by version, so a
# plain `uv sync` may reuse a stale .so):
uv pip install --reinstall-package habemus-papadum-nvenc --no-deps --no-cache packages/nvenc
uv run pytest tests/test_nvenc_gpu_pdum.py -q
uv run ruff check . && uv run ruff format --check .
```
