// Mode B frame sink: transfers each decoded frame to the main thread, where the caller's
// FrameTextureFeed uploads it into a GPU texture in the caller's own context. Ownership of
// the frame moves with the postMessage transfer; on a (shouldn't-happen) transfer failure we
// close the frame so it doesn't leak.

import type { WorkerToMain } from "../types";
import { closeFrame, type FrameSink } from "./frameSink";

export class TransferSink implements FrameSink {
  constructor(private post: (msg: WorkerToMain, transfer: Transferable[]) => void) {}

  draw(src: CanvasImageSource, frameW: number, frameH: number): void {
    const frame = src as VideoFrame | ImageBitmap;
    try {
      this.post({ type: "frame", frame, frameW, frameH }, [frame as unknown as Transferable]);
    } catch {
      closeFrame(src); // transfer failed — don't leak the frame
    }
  }

  dispose(): void {
    /* nothing owned — transferred frames belong to the main thread */
  }
}
