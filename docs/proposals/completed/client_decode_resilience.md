# Client decode resilience — surfacing and recovering from decode stalls

> **SHIPPED.** All six changes below are implemented. Client: a tagged logger
> (`widgets/src/debug.ts`), observable decode/config error paths + `optimizeForLatency`
> (`widgets/src/worker/videoDecode.ts`), and a pure stall watchdog that rebuilds the decoder
> and requests recovery (`widgets/src/worker/stallWatchdog.ts`,
> `tests/unit/stallWatchdog.test.ts`). Server: a `decoder_reset` control + an inflight-timeout
> backstop (`src/pdum/rfb/session.py`, `tests/test_session.py`). The reusable practice is
> written up in `docs/agentic_frontend_debugging.md`. Kept here for the design rationale.

Status: **shipped** (was: proposal). Scope: the browser client (`@habemus-papadum/rfb-widgets`
worker) plus one complementary server-side backstop.

## Why this exists

A hardware-decoder quirk in the NVENC path (the SPS didn't signal
`max_num_reorder_frames=0`, so the browser's **hardware** `VideoDecoder` buffered its DPB
before emitting anything) froze the viewer. **That root cause is fixed** in the encoder
(`packages/nvenc/src/cpp/nvenc_ext.cpp` sets `zeroReorderDelay` + the VUI
`bitstreamRestrictionFlag`; regression test
`tests/test_nvenc_gpu_pdum.py::test_binding_signals_zero_reorder_in_sps`).

But the incident exposed a **latent fragility that has nothing to do with NVENC**: when the
decoder stops producing output for *any* reason, the client and server deadlock **silently
and permanently**, with nothing in the console to explain it and no path back — switching
codec or scene doesn't recover it. The trigger will differ next time (a transient decode
error on the frames in flight, a GPU reset, a dropped keyframe, a codec the HW decoder
buffers differently); the failure shape will be identical. This proposal makes that failure
**observable** and **self-healing**.

## The deadlock, precisely

Two invariants collide:

- **Client only ACKs on display.** The single place the worker emits an `ack` is
  `onDisplayed()` (`widgets/src/worker/entry.ts:56`), called from the `VideoDecoder`'s
  `output` callback (`widgets/src/worker/videoDecode.ts:40`). Every ACK carries
  `displayed: true`. No output ⇒ no ACK.
- **Server only sends when `inflight` has room.** `RfbSession` adds each sent payload's seq
  to `inflight` (`src/pdum/rfb/session.py:156`) and only clears it when an `ack` arrives
  (`session.py:113`, `inflight.discard(seq)`). Before encoding/sending the next frame it
  drops if `len(inflight) >= max_inflight` (`session.py:236`, default `max_inflight=2`).

So once ~2 sent frames fail to display:

```
decoder emits nothing ──► no displayed ACK ──► server inflight stays full
        ▲                                              │
        └────────── server drops every new frame ◄─────┘  (never sends the frame
                     (incl. the forced keyframe)            that might un-stick decode)
```

It is a mutual wait. Critically, **the usual escape hatches don't fire:**

- `request_keyframe` (sent on gate reset / decode-queue backlog,
  `videoDecode.ts:51`, `entry.ts:89`) only sets `force_keyframe = True` server-side
  (`session.py:122`). The keyframe still can't be **sent** — it hits the same
  `inflight >= max_inflight` drop first.
- **Switching backend/scene doesn't help** — the publisher's new frames enter the same full
  `inflight` and are dropped. The session is stranded until the connection is torn down.

## The observability gap

Even while deadlocked, the client says nothing:

- The `VideoDecoder` **error callback is silent** (`videoDecode.ts:49`): it resets the gate
  and requests a keyframe, but never `console.warn`s and never posts an `error` message — so
  the app's `onError` (`RemoteFramebufferView.ts:231`) never fires and the console is empty.
  This is the literal "no console logs to help debug" the incident reported.
- The stall watchdog that *does* exist keys off `decodeQueueSize`
  (`shouldRequestKeyframe`, `backpressure.ts:47`). A decoder that **accepts** chunks and
  buffers them (the reorder case) keeps `decodeQueueSize` low, so this heuristic never trips.
  It detects a *backlog*, not a *stall*.
- The HUD's `displayed` counter simply stops incrementing; there is no "received N chunks,
  displayed 0" signal that would name the problem.

## Proposed changes

Ordered by leverage. (1) and (2) are the minimum that turns a silent brick into a visible,
self-healing hiccup; (5) is the robust backstop that breaks the deadlock even against a buggy
or old client.

1. **Make decode errors observable.** In the `VideoDecoder` `error` handler
   (`videoDecode.ts:49`) and on watchdog trip: `console.warn` with the codec + error, and
   `post({ type: "error", … })` / a softer `decode_warning` so `onError`/`onStats` can show
   it. Distinguish *recoverable* (reset + keyframe) from *fatal* (configure threw / codec
   unsupported).

2. **A real stall watchdog.** Track `queued − displayed` and wall-clock since the last
   `output`. If chunks were queued but nothing displayed for ~1 s, treat it as a stall:
   surface it (per 1), then run recovery (per 3). This is the signal `decodeQueueSize`
   can't give.

3. **Recovery that actually un-sticks decode.** On stall: fully rebuild the decoder
   (`close()` + fresh `configure()`), re-arm the `KeyframeGate`, and request a keyframe. A
   fresh `configure()` clears any bad decoder buffering state that a keyframe alone won't.

4. **Release the server's `inflight` on a client-side stall.** Recovery is useless if the
   server still won't send. The client must tell the server to *stop waiting* for frames it
   will never display — e.g. a `decoder_reset` / `nack{through_seq}` control that clears
   `inflight` (and forces a keyframe) server-side. Do **not** just ACK the stalled seqs with
   `displayed: true` — that would corrupt the displayed-FIFO seq attribution and RTT. A
   distinct control keeps the "displayed means displayed" invariant intact.

5. **Server-side inflight timeout (defense in depth).** Independently of the client, if a seq
   sits in `inflight` unacked for > T (e.g. 2 s), the session should drop it, force a
   keyframe, and log. This single change breaks the deadlock from the server side even when
   the client is an old build or wedged in a way (4) doesn't cover — the most robust
   backstop, and it belongs with the existing latest-frame-wins policy in `session.py`.

6. **`optimizeForLatency: true` in `configure()` (complementary).** Correct for a real-time,
   low-latency stream and reduces decoder-side buffering/latency generally. Note it is a
   *hint*: in this incident the **hardware** decoder ignored it (which is why the encoder-side
   VUI fix was the real cure), so it is defense in depth, not a substitute for (1)–(5).

## Testing

- **Vitest** can cover the core logic without a browser: the deadlock is reproducible purely
  from "N chunks queued via `BackpressureController.onQueued`, zero `onDisplayed`" → assert
  the watchdog trips, an error is surfaced, and a reset/`nack` is emitted. The server
  inflight-timeout is a `RfbSession` unit test (advance the fake clock, assert `inflight`
  clears and a keyframe is forced).
- **Headless caveat.** Playwright's SwiftShader is a *software* decoder and emits regardless
  of the VUI, so it cannot reproduce the original hardware-buffering trigger — only a real
  GPU-backed Chrome does. Resilience tests must therefore simulate the *stall* (no `output`)
  rather than rely on a real decoder to stall.

## Out of scope

- The NVENC reorder VUI itself (already fixed upstream of this doc).
- Reworking the backpressure model; this proposal keeps latest-frame-wins and the
  displayed-ACK semantics, adding only stall detection, recovery, and a timeout backstop.
