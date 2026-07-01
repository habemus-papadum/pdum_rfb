# Synchronous 1-in-1-out vs. pipelined encode — seq attribution notes

_Quick design thoughts (not yet a decision). Prompted by: "is synchronous 1-in-1-out a
good default for performance, or only for testing/seq-correlation?"_

## What "1-in-1-out" actually buys, and where the requirement comes from

The session does **not** track which compressed access unit (AU) belongs to which
published frame by parsing the bitstream. It relies on **call ordering**: every
`encoder.encode(frame)` call stamps the returned payload(s) with **that call's**
`frame.seq`, sends them, and books `seq` into `inflight` + `_send_times[seq]`
(`session.py:_encode_step` → `send_payload`, lines ~190–198, 144–150). The browser ACKs
`{seq, displayed}`; the server pops `_send_times[seq]` to get RTT and clears `inflight`
(`_handle_control`, lines ~99–111).

That bookkeeping is only correct if **the bytes returned by `encode(frame_N)` really are
frame N's AU**. Two things can break that:

1. **Pipeline delay.** A hardware encoder with output delay > 0 returns *nothing* for the
   first few `encode()` calls (filling its pipeline), then returns an *earlier* frame's AU
   from a *later* call. The current Python wrappers stamp the *current* call's `frame.seq`
   onto whatever bytes come out — so `encode(frame_5)` returning frame_3's AU would
   mislabel it `seq=5`. RTT, `displayed`, `inflight`, and "what's actually on screen" all
   get misattributed by the pipeline depth.
2. **Frame reordering (B-frames).** Output order ≠ input order, so even a FIFO of seqs
   would be wrong. This is separately banned by the project invariant (no B-frames).

So the encoders are configured for **synchronous 1-in-1-out**:
- `pdum.nvenc` `NvencEncoder`: `extra_output_delay = 0` (NvEncoder pipeline depth 1; each
  `encode()` returns its own frame's AU).
- `pdum.vtenc` `VtEncoder`: `VTCompressionSessionCompleteFrames(kCMTimeInvalid)` after every
  `EncodeFrame` (block until this frame's callback has fired).
- both: `AllowFrameReordering=false` / `frameIntervalP=1` (no B-frames).

It is genuinely **two guarantees**: (a) one AU out per frame in, and (b) output order ==
input order. The session's simple seq labeling needs both.

## Two different "correlation" concerns (don't conflate them)

- **Output-frame ↔ published-seq** — needed for `displayed:true` ACK, RTT, and
  "which published frame is on screen now." This is the one 1-in-1-out protects. It is a
  *correctness* property of the stats/backpressure layer, not just a test affordance.
- **Input-event ↔ frame** — "the pointer moved at T; which rendered frame reflects it?"
  This is owned by the **publisher's render loop**: an event drained via `poll_events()`
  updates state, and the next `publish()` bumps `seq`. The encoder's pipeline depth does
  **not** change this mapping; it only adds *latency* between `publish(seq N)` and seq N
  appearing on screen. So pipelining doesn't corrupt event→frame correlation — it just
  lengthens the glass-to-glass delay (which matters for interactivity, see below).

## Is 1-in-1-out a good default for performance?

For this library's model — **interactive, latest-frame-wins, low-latency** — yes:

- **Latency:** 1-in-1-out is optimal. No frames are held in the encoder; each AU ships the
  instant it's ready. Pipelining *adds* N frames of glass-to-glass delay (≈ N/fps), which
  is exactly what an interactive viewer feels as input lag.
- **Throughput:** this is what 1-in-1-out costs. The session encodes serially (encode on a
  worker thread via `asyncio.to_thread`, but the loop *awaits* it before pulling the next
  frame), so there is **no overlap** between encoding frame N and rendering/encoding frame
  N+1, and the HW encoder's internal stages aren't kept maximally busy. For a single
  interactive stream this is usually a non-issue (encode ≪ frame interval). It bites only
  in throughput-bound regimes: very high fps, 4K, many concurrent streams, or offline
  recording where latency doesn't matter.

The tension: 1-in-1-out trades peak throughput for minimal latency + trivially-correct seq
attribution. That trade is *right* for the interactive default, but it shouldn't be
*hard-wired* — a throughput-oriented publisher should be able to opt into pipelining.

## How to make pipelining safe (decouple throughput from seq correctness)

The fix is to stop inferring seq from **call order** and instead **carry the seq through
the encoder as an opaque token**, recovering it on the way out. Every backend already has
a per-frame timestamp channel for exactly this:

| Backend | Token channel |
| --- | --- |
| `pdum.nvenc` | `NV_ENC_PIC_PARAMS.inputTimeStamp` (currently an internal counter) → echoed on `NvEncOutputFrame` |
| `pdum.vtenc` | `VTCompressionSessionEncodeFrame` `pts` (`CMTime`) and/or `sourceFrameRefCon` → echoed on the output `CMSampleBuffer` |
| `h264_cpu` (PyAV) | `VideoFrame.pts` → `Packet.pts` |

Concretely:
1. Pass `seq` (not an internal counter) as the input timestamp/refcon.
2. Have the binding return AUs tagged with the **recovered** input timestamp, so a payload
   carries the seq of the frame it actually encodes — regardless of pipeline depth.
3. Change `_encode_step` to stamp `payload.seq` from the **recovered** token, not from the
   input `frame.seq`, and to tolerate `encode()` returning 0 or >1 AUs (drain whatever is
   ready). `inflight`/`_send_times` already key on `seq`, so they keep working.

With that, the encoder can run at pipeline depth > 1 (`extra_output_delay=k` / drop the
per-frame `CompleteFrames`) for throughput **without** breaking stats or the displayed-ACK.
No B-frames is still required (the browser-side FIFO assumes output order == input order;
relaxing that is a separate, bigger change involving DTS/PTS reorder buffers — out of scope).

## Recommendation

1. **Keep synchronous 1-in-1-out as the default.** It matches the interactive,
   latest-frame-wins model, minimizes latency, and keeps seq attribution trivially correct.
2. **Expose it as a knob**, not a constant — e.g. `serve(encode_pipeline_depth=0)` (0 =
   synchronous) plumbed to `extra_output_delay` (nvenc) / a "don't CompleteFrames every
   frame" mode (vtenc). Default 0.
3. **Before** enabling depth > 1, do the token-based seq recovery above so pipelining is
   *correct*, not just faster. Until then, 1-in-1-out is load-bearing and should stay the
   default and the only supported mode.
4. Treat this as orthogonal to the zero-copy work (it's an output-side/latency concern;
   zero-copy is an input-side/bandwidth concern) — they compose but don't depend on each
   other.

> Note for the upcoming benchmark: report **both** latency (glass-to-glass / encode-to-AU)
> and throughput (sustained fps) per mode, so the 1-in-1-out-vs-pipelined trade is measured
> rather than assumed — the same way `docs/gpu_zerocopy.md` measured the CUDA path.
