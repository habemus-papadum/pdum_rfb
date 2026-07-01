// Video path: H.264 Annex B chunks -> VideoDecoder -> draw. Owns the decoder
// lifecycle, the keyframe gate, and seq attribution for display ACKs.

import type { BackpressureController, KeyframeGate } from "../backpressure";
import type { VideoChunkHeader } from "../protocol";
import type { Renderer } from "./renderer";

export class VideoPipeline {
  private decoder: VideoDecoder | null = null;
  private codec = "";
  private codedWidth = 0;
  private codedHeight = 0;

  constructor(
    private renderer: Renderer,
    private bp: BackpressureController,
    private gate: KeyframeGate,
    private onRequestKeyframe: (reason: string) => void,
    private onDisplayed: (seq: number) => void,
  ) {}

  get decodeQueueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  private ensureDecoder(header: VideoChunkHeader): void {
    if (
      this.decoder &&
      this.codec === header.codec &&
      this.codedWidth === header.width &&
      this.codedHeight === header.height
    ) {
      return;
    }
    this.close();
    this.codec = header.codec;
    this.codedWidth = header.width;
    this.codedHeight = header.height;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          // Use the frame's *display* size (the intended pixels), not its coded size
          // (which is padded up to the codec's macroblock grid).
          this.renderer.draw(frame, frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight);
        } finally {
          frame.close(); // VideoFrame holds GPU/decoder resources; close promptly
        }
        const seq = this.bp.onDisplayed();
        if (seq !== undefined) this.onDisplayed(seq);
      },
      error: (e) => {
        this.gate.reset();
        this.onRequestKeyframe(String(e));
      },
    });
    // Annex B mode: SPS/PPS are in-band on key chunks, so omit `description`.
    this.decoder.configure({
      codec: header.codec,
      codedWidth: header.width,
      codedHeight: header.height,
    });
    this.gate.reset();
  }

  handleChunk(header: VideoChunkHeader, payload: Uint8Array): void {
    this.ensureDecoder(header);
    if (!this.gate.accept(header.keyframe)) {
      // A VideoDecoder must start from a keyframe; drop deltas until one arrives.
      this.onRequestKeyframe("awaiting keyframe");
      return;
    }
    const chunk = new EncodedVideoChunk({
      type: header.keyframe ? "key" : "delta",
      timestamp: header.timestamp_us,
      duration: header.duration_us,
      data: new Uint8Array(payload),
    });
    this.bp.onQueued(header.seq);
    this.decoder!.decode(chunk);
  }

  reset(): void {
    this.gate.reset();
    this.bp.reset();
  }

  close(): void {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        /* already closed */
      }
      this.decoder = null;
    }
  }
}
