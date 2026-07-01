# Pipelined encode — NVENC implementation guide (Linux/CUDA agent)

> **Status: IMPLEMENTED** (RTX 4090 Laptop, CUDA 13). `NvencEncoder.submit()` /
> `flush_pipeline()`, `NvencGpuPdumEncoder(pipeline_depth=…)`, the factory forward, tests
> (`tests/test_nvenc_gpu_pdum.py`), and a benchmark (`examples/nvenc_pipeline_bench.py`,
> ≈1.2× at 1080p, ~1.5× at 720p) all landed. Results are in
> [`pipelined_encode.md`](pipelined_encode.md#nvenc-linuxcuda-where-it-pays-off).
>
> **One necessary deviation from the plan below.** Steps 1–2 assume `seq` rides
> `NV_ENC_PIC_PARAMS.inputTimeStamp` and is read back on `NvEncOutputFrame.timeStamp`. It
> does **not** survive: NVIDIA's vendored `NvEncoder::DoEncode` overwrites `inputTimeStamp`
> with its own counter (`NvEncoder_130.cpp:690` / `_121.cpp:653`), and
> `packages/nvenc/third_party/` is kept verbatim. Because `frameIntervalP=1` guarantees
> output order == input order, the binding instead recovers seq from an **in-order FIFO**
> of the tags pushed at `submit()` (`m_pending_seqs`, popped in `tag()`) — equivalent, and
> independent of the SDK's internal timestamp. Everything else matches the guide.

This is a build-it task for an agent on a **Linux box with an NVIDIA NVENC GPU + CUDA
toolkit**. The pipelined-encode feature (see [`pipelined_encode.md`](../../pipelined_encode.md)) is
already implemented end-to-end on the **VideoToolbox** backend and wired through the session
and `serve(encode_pipeline_depth=…)`. VideoToolbox was measured to gain **nothing** from
pipelining (its low-latency RC is synchronous). **NVENC is the backend where it pays off** —
`extra_output_delay > 0` keeps multiple frames in flight and overlaps encode with
render/convert. Your job is to add the NVENC half, mirroring the VideoToolbox reference.

Everything above the `EncoderBackend` seam is done and **must not change**: the session
already iterates `payloads` and books each `payload.seq`; `build_encoder(…, pipeline_depth=)`
and `serve(encode_pipeline_depth=)` already thread the knob. You implement two layers and flip
one factory line.

## The reference implementation to mirror

| Layer | VideoToolbox (done) | NVENC (your task) |
| --- | --- | --- |
| Native binding | `packages/vtenc/src/cpp/vtenc_ext.mm` — `submit()` / `flush_pipeline()` | `packages/nvenc/src/cpp/nvenc_ext.cpp` |
| Token channel | `sourceFrameRefCon` → `CMSampleBuffer` | `NV_ENC_PIC_PARAMS.inputTimeStamp` → `NvEncOutputFrame.timeStamp` |
| rfb wrapper | `src/pdum/rfb/encoders/vtenc.py` `VideoToolboxEncoder` (`pipeline_depth`, `_pending_ts`, `_encode_pipelined`) | `src/pdum/rfb/encoders/nvenc_gpu_pdum.py` `NvencGpuPdumEncoder` |
| Factory wiring | `_vtenc_factory` forwards `pipeline_depth` | `_nvenc_gpu_pdum_factory` (flip from drop → forward) |
| Tests | `tests/test_vtenc.py` (`test_pipelined_*`) | `tests/test_nvenc.py` |

Read the VideoToolbox versions first — your code should be a near-structural copy with NVENC
APIs swapped in. The contract is identical: a pipelined `submit()` returns
`list[(recovered_seq, annexb_bytes, keyframe)]` (0..N tuples, output order == input order, no
B-frames), and the wrapper stamps each payload with the **recovered** seq, not the call's
`frame.seq`.

## Good news: the binding is already 90% there

`NvencEncoder` (`packages/nvenc/src/cpp/nvenc_ext.cpp`) already has everything pipelining
needs — you are exposing it, not building it:

- The constructor takes **`extra_output_delay`** (default `0` = 1-in-1-out). `> 0` is exactly
  pipeline depth (NVIDIA's own default is 3). It is already plumbed into
  `NV_ENC_CONFIG`/the encoder's buffer pool.
- `encode()` already sets `pic.inputTimeStamp = m_frame_num++` and calls
  `m_enc->EncodeFrame(out, &pic)`, which returns `std::vector<NvEncOutputFrame>` — **0..N**
  frames already (it returns empty while the pipeline fills, then earlier frames later).
- `NvEncOutputFrame` (`third_party/NvEncoder/NvEncoder_130.h:83`) carries exactly what you
  need to recover the tag:
  ```cpp
  struct NvEncOutputFrame {
      std::vector<uint8_t> frame;   // Annex B bytes
      NV_ENC_PIC_TYPE pictureType;  // keyframe = NV_ENC_PIC_TYPE_IDR / _I
      uint64_t timeStamp;           // ECHOES inputTimeStamp -> the recovered seq
  };
  ```

So the *only* reasons today's path is synchronous-only are: (1) `inputTimeStamp` is an
internal counter, not the caller's `seq`; (2) `encode()`/`collect()` concatenate to `bytes`,
discarding `timeStamp`/`pictureType`; (3) the wrapper stamps `frame.seq` on the call.

## Step 1 — binding: add `submit()` and `flush_pipeline()`

In `packages/nvenc/src/cpp/nvenc_ext.cpp`, keep `encode()→bytes` and `flush()→bytes`
**unchanged** (the synchronous default). Add two methods returning seq-tagged tuples. The
input-read + `CopyToDeviceFrame` block is identical to `encode()` — factor it out or copy it.

```cpp
// Pipelined: submit one CUDA NV12 frame tagged with `seq` (carried as inputTimeStamp),
// WITHOUT assuming 1-in-1-out. Returns the AUs ready now as (recovered_seq, annexb, keyframe).
std::vector<std::tuple<uint64_t, py::bytes, bool>> submit(py::object frame, int64_t seq,
                                                          bool force_idr) {
    if (!m_enc) throw std::runtime_error("encoder is closed");
    // --- identical to encode(): read __cuda_array_interface__, GetNextInputFrame,
    //     CopyToDeviceFrame into in->inputPtr (see encode() lines ~175-195) ---
    std::vector<NvEncOutputFrame> out;
    {
        NV_ENC_PIC_PARAMS pic = {NV_ENC_PIC_PARAMS_VER};
        pic.inputTimeStamp = (uint64_t)seq;                 // <-- the token (was m_frame_num++)
        if (force_idr) pic.encodePicFlags |= NV_ENC_PIC_FLAG_FORCEIDR;
        py::gil_scoped_release rel;
        m_enc->EncodeFrame(out, &pic);                      // 0..N ready frames
    }
    return tag(out);                                        // GIL re-held
}

// Complete the in-flight tail; returns the remaining seq-tagged AUs.
std::vector<std::tuple<uint64_t, py::bytes, bool>> flush_pipeline() {
    if (!m_enc) return {};
    std::vector<NvEncOutputFrame> out;
    { py::gil_scoped_release rel; m_enc->EndEncode(out); }
    return tag(out);
}

private:
// Parallel of vtenc's aus_to_list(): build list[(seq, bytes, keyframe)]. GIL held.
std::vector<std::tuple<uint64_t, py::bytes, bool>> tag(std::vector<NvEncOutputFrame> &out) {
    std::vector<std::tuple<uint64_t, py::bytes, bool>> r;
    r.reserve(out.size());
    for (auto &o : out) {
        bool key = (o.pictureType == NV_ENC_PIC_TYPE_IDR || o.pictureType == NV_ENC_PIC_TYPE_I);
        r.emplace_back(o.timeStamp, py::bytes((const char *)o.frame.data(), o.frame.size()), key);
    }
    return r;
}
```

Bind them next to the existing `encode`/`flush` in `PYBIND11_MODULE`:

```cpp
.def("submit", &NvencEncoder::submit, py::arg("frame"), py::arg("seq"),
     py::arg("force_idr") = false,
     "Pipelined: submit one CUDA NV12 frame tagged with seq, returning the access units "
     "ready now as (seq, annexb_bytes, keyframe) tuples (0..N). Pair with flush_pipeline().")
.def("flush_pipeline", &NvencEncoder::flush_pipeline,
     "Complete the in-flight tail; returns remaining (seq, annexb_bytes, keyframe) tuples.")
```

> **Sanity caveat — does `seq` as `inputTimeStamp` round-trip?** NVENC treats `inputTimeStamp`
> as opaque and echoes it on `timeStamp`. The seqs are monotonically increasing (the session's
> per-client counter), which keeps NVENC happy. Verify with the depth assertion in Step 4: at
> `extra_output_delay≥1` the first call(s) must return `[]` and a later call must return an
> *earlier* seq — that is the proof the token survives the pipeline.

## Step 2 — rfb wrapper: `pipeline_depth` on `NvencGpuPdumEncoder`

In `src/pdum/rfb/encoders/nvenc_gpu_pdum.py`, mirror `VideoToolboxEncoder` exactly:

1. Add `pipeline_depth: int = 0` to `__init__`; store `self.pipeline_depth = max(0, int(...))`
   and `self._pending_ts: dict[int, int] = {}`.
2. Pass it to the SDK encoder as the delay: `NvencEncoder(…, extra_output_delay=self.pipeline_depth)`.
3. Branch `encode()`:

```python
def encode(self, frame, *, force_keyframe=False):
    import cupy as cp
    packed = self._packed_nv12(frame)
    cp.cuda.runtime.deviceSynchronize()   # NV12 ready before NVENC's copy (keep this!)
    self.frame_index += 1
    if self.pipeline_depth > 0:
        self._pending_ts[frame.seq] = frame.timestamp_us
        aus = self._enc.submit(packed, frame.seq, force_idr=force_keyframe)
        return [self._payload(s, self._pending_ts.pop(s, frame.timestamp_us), d, k) for s, d, k in aus]
    data = self._enc.encode(packed, force_idr=force_keyframe)
    return [self._payload(frame.seq, frame.timestamp_us, data, force_keyframe or _contains_idr(data))] if data else []

def flush(self):
    if self.pipeline_depth > 0:
        aus = self._enc.flush_pipeline()
        return [self._payload(s, self._pending_ts.pop(s, 0), d, k) for s, d, k in aus]
    data = self._enc.flush()
    return [self._payload(-1, 0, data, _contains_idr(data))] if data else []
```

Note the recovered `keyframe` now comes straight from `pictureType` (more accurate than
`_contains_idr`). `encode_still()` is unchanged (it just forces an IDR via `encode`).

### Pitfall: the single reusable `self._nv12` staging buffer

The sync path reuses one `self._nv12` because "ll tuning consumes each frame before the next."
Under pipelining that assumption is gone — but `CopyToDeviceFrame` copies `self._nv12` into
**NVENC's own input ring slot** (`GetNextInputFrame()->inputPtr`) inside `submit()` before it
returns, so `self._nv12` is free to overwrite afterward. This is safe **provided the copy has
completed** — which is why the `deviceSynchronize()` stays. Confirm NVENC's input buffer pool
is ≥ the delay (`NvEncoderCuda` sizes it from the encode config; if you see corruption at high
depth, that pool is the first suspect). The pure-CUDA-NV12 input path (no `rgb_to_nv12`, no
staging buffer) is the cleanest case — test it first.

## Step 3 — flip the factory

In `src/pdum/rfb/encoders/base.py`, `_nvenc_gpu_pdum_factory` currently **drops**
`pipeline_depth` (so depth>0 was a documented no-op). Change it to **forward**:

```python
def _nvenc_gpu_pdum_factory(**kwargs) -> EncoderBackend:
    from .nvenc_gpu_pdum import NvencGpuPdumEncoder
    return NvencGpuPdumEncoder(**kwargs)   # now consumes pipeline_depth
```

Leave the other NVENC factories (`_nvenc_cpu_factory`, `_nvenc_gpu_pyav_factory`) dropping it —
they ride PyAV and are out of scope.

## Step 4 — tests (`tests/test_nvenc.py`)

Mirror `tests/test_vtenc.py`'s `test_pipelined_submit_recovers_seq_in_order_no_loss` and
`test_wrapper_pipeline_depth_recovers_seq`, gated by the existing NVENC availability skip. Two
NVENC-specific must-haves the VT tests can't assert:

1. **Real pipelining (the proof of the win).** With `extra_output_delay≥2`, assert the encoder
   actually buffers: some early `submit()` calls return `[]` and the **max observed depth
   (`submitted − emitted`) is ≥ 1**. On VideoToolbox this is always 0; on NVENC it must be
   > 0, or pipelining is not happening.
2. **Seq integrity through the pipeline.** Collected seqs across all `submit()` + `flush_pipeline()`
   == `list(range(N))` in order, every frame exactly once, decode-back with PyAV recovers ~N
   frames at the right dimensions, frame 0 is the only keyframe (with a large gop).

```python
def test_nvenc_pipelined_recovers_seq_and_pipelines():
    enc = NvencEncoder(W, H, codec="h264", fps=30, gop=30, bitrate=6_000_000, extra_output_delay=3)
    seqs, blob, emitted, max_depth = [], b"", 0, 0
    for seq in range(N):
        aus = enc.submit(cuda_nv12(seq), seq, force_idr=(seq == 0))
        emitted += len(aus)
        max_depth = max(max_depth, (seq + 1) - emitted)
        for s, d, k in aus: seqs.append(s); blob += d
    for s, d, k in enc.flush_pipeline(): seqs.append(s); blob += d
    enc.close()
    assert seqs == list(range(N))            # recovered + in order + no loss
    assert max_depth >= 1                     # <-- NVENC actually pipelines (VT would be 0)
    assert len(decode_annexb(blob)) >= N - 3
```

Also add a wrapper-level test (`NvencGpuPdumEncoder(pipeline_depth=2)`, recovered payload seqs)
and a `build_encoder(..., video_encoder="nvenc_gpu_pdum", pipeline_depth=2)` plumbing test
mirroring `test_build_encoder_threads_pipeline_depth_to_vtenc`.

## Step 5 — benchmark the win

Unlike VideoToolbox, you should see a **real throughput increase**. Extend the NVENC
benchmark (or write an apples-to-apples encoder-only loop like
`examples/mlx_vt_bench.py --compare-pipeline`: same prebuilt CUDA NV12, only `encode()` vs
`submit()` differs) and report sync fps vs pipelined fps vs depth at 1080p/1440p/4K. Record
the numbers in [`pipelined_encode.md`](../../pipelined_encode.md)'s "NVENC" subsection and
`docs/performance.md`. Expectation: pipelined fps > sync fps, max depth ≈ `extra_output_delay`.
If you measure **no** speedup, stop and report — it means NVENC is already throughput-bound on
that GPU at that resolution (the per-frame encode already saturates the engine), which is a
finding, not a bug.

## Build & verify environment

```bash
# Build the native package (needs CUDA toolkit + NVENC headers; auto-detected):
RFB_GPU=force uv sync --extra gpu-nvenc-sdk          # or packages/nvenc/build-wheel.sh
uv run python -c "from pdum.rfb.encoders.nvenc_gpu_pdum import nvenc_gpu_pdum_available as a; print(a())"
uv run pytest tests/test_nvenc.py -q                  # your new tests
uv run ruff check . && uv run ruff format --check .
```

The native rebuild has the same **uv build-cache gotcha** seen on the vtenc side: uv caches the
editable build by version, so after editing `nvenc_ext.cpp` rebuild with
`uv pip install --reinstall-package habemus-papadum-nvenc --no-deps --no-cache packages/nvenc`
(plain `uv sync` may reuse a stale `.so`).

## Acceptance criteria

- [ ] `NvencEncoder.submit()` / `flush_pipeline()` return `list[(seq, bytes, keyframe)]`;
      `encode()` / `flush()` byte-identical to before.
- [ ] `NvencGpuPdumEncoder(pipeline_depth=k>0)` recovers seqs from `timeStamp`, threads the
      original `timestamp_us` via `_pending_ts`, and passes `extra_output_delay=k`.
- [ ] `_nvenc_gpu_pdum_factory` forwards `pipeline_depth`; `serve(encode_pipeline_depth=k)`
      reaches a real NVENC viewer (the session/plumbing is unchanged and already tested).
- [ ] Tests prove **recovered-seq order + no loss + decode-back**, and **max depth ≥ 1**
      (real pipelining), all skipped off-NVENC.
- [ ] A benchmark shows pipelined vs sync throughput; numbers recorded in the docs.
- [ ] No B-frames anywhere (NVENC `frameIntervalP=1` / no B — already the case; re-confirm).

## Why no session/protocol changes

The session books `payload.seq` from whatever the wrapper returns, so recovered-seq payloads
"just work": `inflight`, `_send_times[seq]` (RTT), and the `displayed:true` FIFO all key on
`seq`. Latest-frame-wins still drops *before* `submit()`, so the encoder pipeline only ever
holds a valid reference chain; `max_inflight` bounds the wire independent of encoder depth. The
browser is untouched (Annex B in `seq` order, keyframes intact). See
[`internals.md`](../../internals.md#pipelined-encode-token-based-seq-attribution).
