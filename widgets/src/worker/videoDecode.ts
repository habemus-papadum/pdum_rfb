// Video path: H.264 Annex B chunks -> VideoDecoder -> draw. Owns the decoder lifecycle,
// the keyframe gate, seq attribution for display ACKs, and — crucially — **stall recovery**:
// a decoder that stops emitting output (HW DPB buffering, a transient decode error, a
// dropped keyframe) otherwise deadlocks the client + server silently and permanently. The
// StallWatchdog surfaces that and drives a decoder rebuild + a server-side inflight reset.
// See docs/proposals/completed/client_decode_resilience.md.

import type { BackpressureController, KeyframeGate } from "../backpressure";
import type { Logger } from "../debug";
import type { VideoChunkHeader } from "../protocol";
import type { Renderer } from "./renderer";
import { StallWatchdog } from "./stallWatchdog";

const noLog: Logger = { enabled: false, log: () => {}, error: () => {} };
const defaultNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Resilience wiring — kept as an options bag so the core args stay readable. */
export interface DecodeHooks {
  /** Tell the server to clear its `inflight` (the client stalled and rebuilt its decoder). */
  onDecoderReset?: () => void;
  /** A recoverable stall/decode-error was auto-recovered (bump a stat). */
  onRecovered?: () => void;
  /** Unrecoverable: `configure()` threw / codec unsupported. Surface to `onError`. */
  onFatal?: (message: string) => void;
  /** Monotonic clock (ms); injectable for tests. */
  now?: () => number;
  /** Backlog age with zero output that counts as a stall (ms). */
  stallMs?: number;
}

export class VideoPipeline {
  private decoder: VideoDecoder | null = null;
  private codec = "";
  private codedWidth = 0;
  private codedHeight = 0;
  private lastHeader: VideoChunkHeader | null = null;
  private watchdog: StallWatchdog;
  private hooks: Required<Omit<DecodeHooks, "stallMs" | "now">> & { now: () => number };

  constructor(
    private renderer: Renderer,
    private bp: BackpressureController,
    private gate: KeyframeGate,
    private onRequestKeyframe: (reason: string) => void,
    private onDisplayed: (seq: number) => void,
    private log: Logger = noLog,
    hooks: DecodeHooks = {},
  ) {
    const now = hooks.now ?? defaultNow;
    this.hooks = {
      onDecoderReset: hooks.onDecoderReset ?? (() => {}),
      onRecovered: hooks.onRecovered ?? (() => {}),
      onFatal: hooks.onFatal ?? (() => {}),
      now,
    };
    this.watchdog = new StallWatchdog(hooks.stallMs ?? 1200, now, () => this.recover());
  }

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
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          // Use the frame's *display* size (the intended pixels), not its coded size
          // (which is padded up to the codec's macroblock grid).
          this.renderer.draw(frame, frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight);
        } finally {
          frame.close(); // VideoFrame holds GPU/decoder resources; close promptly
        }
        this.watchdog.onDisplayed();
        const seq = this.bp.onDisplayed();
        if (seq !== undefined) this.onDisplayed(seq);
      },
      error: (e) => {
        // Recoverable: the decoder errored on the frames in flight. Surface it (it was
        // silent before — the "no console logs" the incident reported), then re-arm.
        this.log.error("decode", "VideoDecoder error", e);
        this.gate.reset();
        this.onRequestKeyframe(`decode error: ${e}`);
      },
    });
    // Annex B mode: SPS/PPS are in-band on key chunks, so omit `description`.
    // optimizeForLatency: correct for a real-time stream (a hint; HW decoders may ignore it).
    this.log.log("decode", "configure", { codec: header.codec, w: header.width, h: header.height });
    try {
      decoder.configure({
        codec: header.codec,
        codedWidth: header.width,
        codedHeight: header.height,
        optimizeForLatency: true,
      });
    } catch (e) {
      // Fatal: unsupported codec / bad config. A rebuild won't help — surface to onError.
      try {
        decoder.close();
      } catch {
        /* already dead */
      }
      this.log.error("decode", "configure() failed (fatal)", e);
      this.hooks.onFatal(`video decoder configure failed: ${e}`);
      return; // leave this.decoder null; handleChunk no-ops until a new config arrives
    }
    this.decoder = decoder;
    this.gate.reset();
  }

  handleChunk(header: VideoChunkHeader, payload: Uint8Array): void {
    this.lastHeader = header;
    this.ensureDecoder(header);
    if (!this.decoder) return; // fatal configure — nothing to feed
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
    this.watchdog.onQueued();
    this.decoder.decode(chunk);
  }

  /** Called periodically by the worker's watchdog tick; triggers recovery on a stall. */
  checkStall(): void {
    this.watchdog.check();
  }

  /** Rebuild the decoder from scratch, re-arm, request a keyframe, and tell the server to
   *  release its inflight — the only thing that un-sticks a decoder that stopped emitting. */
  private recover(): void {
    const header = this.lastHeader;
    this.log.error("stall", "decode stall detected — rebuilding decoder, requesting keyframe + server reset");
    this.close();
    this.watchdog.reset();
    this.gate.reset();
    this.bp.reset();
    if (header) this.ensureDecoder(header); // fresh configure() clears bad buffering state
    this.onRequestKeyframe("decoder stall recovery");
    this.hooks.onDecoderReset(); // -> server clears inflight so it can send the keyframe
    this.hooks.onRecovered(); // -> bump the recoveries stat
  }

  reset(): void {
    this.gate.reset();
    this.bp.reset();
    this.watchdog.reset();
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
