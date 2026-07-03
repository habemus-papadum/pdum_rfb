// Bench decode worker for the transfer benchmark (mode=transfer in bench-harness.ts).
//
// Stands in for the real decode worker's producer side: it owns a deterministic moving-frame
// pool and, on each `next` request, builds a frame and TRANSFERS it to the main thread — the
// exact `postMessage(frame, [frame])` handoff `worker/transferSink.ts` performs for Mode B
// (`FrameTextureFeed`). One frame per request (ping-pong) so nothing queues up: the measured
// `postAbs → recv` gap is the pure Transferable handoff, not queue-drain latency.
//
// Cross-thread timing: `performance.now()` has a per-context `timeOrigin`, so worker and main
// clocks are NOT directly comparable. We stamp `performance.now() + performance.timeOrigin`
// (absolute ms since the Unix epoch, comparable across contexts) right before posting; main
// subtracts it from its own absolute receive time. Resolution is bounded by cross-origin
// isolation — see the caveat in the harness/specs.

import { makeFrame, makePool } from "./benchFrames";

interface InitMsg {
  type: "init";
  frameW: number;
  frameH: number;
  poolSize: number;
  sourceKind: string;
}
interface NextMsg {
  type: "next";
  i: number;
}
type InMsg = InitMsg | NextMsg;

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer);

let pool: OffscreenCanvas[] = [];
let frameW = 0;
let frameH = 0;
let sourceKind = "videoframe";

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    frameW = msg.frameW;
    frameH = msg.frameH;
    sourceKind = msg.sourceKind;
    pool = makePool(msg.poolSize, frameW, frameH);
    post({ type: "ready", crossOriginIsolated: (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true });
    return;
  }
  // "next": build a frame, then transfer it stamped with an absolute post time.
  const src = pool[msg.i % pool.length];
  const c0 = performance.now();
  const frame = await makeFrame(src, msg.i * 1000, sourceKind);
  const createMs = performance.now() - c0;
  const postAbs = performance.now() + performance.timeOrigin;
  post({ type: "frame", frame, frameW, frameH, i: msg.i, postAbs, createMs }, [frame as unknown as Transferable]);
};
