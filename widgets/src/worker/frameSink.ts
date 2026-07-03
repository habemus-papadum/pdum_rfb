// The decode pipeline's output target. The video/image decoders don't know whether the
// frame will be PRESENTED (Mode A: the worker owns a canvas and draws it) or FED to the
// caller (Mode B: the frame is transferred to the main thread and uploaded into the caller's
// GPU texture). Both are FrameSinks.
//
// Ownership contract: `draw()` TAKES OWNERSHIP of `src` (a VideoFrame or ImageBitmap). The
// sink either copies it and closes it (Renderer/present) or transfers it (TransferSink/feed).
// The decode pipeline must NOT close the frame itself.

export interface FrameSink {
  /** Consume one decoded frame (`frameW x frameH` display px). Takes ownership of `src`. */
  draw(src: CanvasImageSource, frameW: number, frameH: number): void;
  dispose(): void;
}

/** Close a decoded source if it is closeable (VideoFrame / ImageBitmap). */
export function closeFrame(src: CanvasImageSource): void {
  (src as { close?: () => void }).close?.();
}
