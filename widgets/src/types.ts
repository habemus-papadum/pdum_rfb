// Message contract between the main thread and the decoding worker. Only types
// available in both DOM and WebWorker libs are referenced here.

import type { NormalizedEvent } from "./eventTypes";
import type { FitMode } from "./viewport";

export type ConnectionState = "connecting" | "reconnecting" | "open" | "negotiated" | "closed" | "error";

/** The client draw path (compositing backend). Canvas2D is the always-available floor. */
export type SurfaceKind = "2d" | "webgl" | "webgpu";
/** What a caller may request: a specific backend, or `"auto"` (prefer the GPU tiers, fall
 *  back to Canvas2D). Default is `"2d"` — a GPU path is opt-in ("measure first"). */
export type SurfacePreference = SurfaceKind | "auto";

export interface WorkerInitOptions {
  maxInflight?: number;
  slowDownQueue?: number;
  keyframeOnDropQueue?: number;
  imageOnly?: boolean;
  /** Auth credential forwarded in the `hello` message. */
  token?: string;
  /** Fit mode when frame AR differs from canvas AR (default `"contain"`). */
  fit?: FitMode;
  /** Letterbox fill for `contain` (any CSS color; default `"#000"`). */
  background?: string;
  /** Compositing backend to use for the draw path (default `"2d"`; `"auto"` prefers the
   *  GPU tiers). Falls back to Canvas2D if the requested context is unavailable. */
  surface?: SurfacePreference;
  /** Verbose client-side console logging (per-frame decode play-by-play). Genuine errors and
   *  lifecycle notices surface either way; this adds the firehose. Default `false`. */
  debug?: boolean;
  /** Lifecycle `notice()` logging (WS/negotiation/keyframe/backpressure/recovery/resize).
   *  Default `true`. */
  notice?: boolean;
}

export type MainToWorker =
  | {
      type: "init";
      url: string;
      /** `"present"` (default, Mode A: worker owns a canvas and draws) or `"feed"` (Mode B:
       *  frames are transferred to the main thread for the caller to composite). */
      mode?: "present" | "feed";
      /** Present mode only — the transferred drawing surface. */
      canvas?: OffscreenCanvas;
      devicePixelRatio?: number;
      backingWidth?: number;
      backingHeight?: number;
      cssWidth?: number;
      cssHeight?: number;
      options: WorkerInitOptions;
    }
  | { type: "event"; event: NormalizedEvent }
  | {
      type: "resize";
      backingWidth: number;
      backingHeight: number;
      cssWidth: number;
      cssHeight: number;
      pixelRatio: number;
    }
  | { type: "capture"; id: number; format: "imagedata" | "blob" }
  | { type: "set_fit"; fit?: FitMode; background?: string }
  | { type: "dispose" };

export interface Stats {
  framesDisplayed: number;
  framesDropped: number;
  lastDisplayedSeq: number;
  decodeQueueSize: number;
  transport: "image" | "webcodecs" | "none";
  /** Active client draw path (`"2d"` | `"webgl"` | `"webgpu"`), after any fallback. Set
   *  once the worker builds the surface at init. */
  surface?: SurfaceKind;
  /** Times the client auto-recovered a decode stall/error (rebuild + keyframe). Undefined
   *  until the first recovery; a nonzero value means the stream hit — and survived — a stall. */
  recoveries?: number;
  // Server-truth metrics, populated from the server's `stats` / `set_quality`
  // control messages (undefined until the server pushes them; enable with
  // `serve(stats_interval=...)`). The decode-side fields above are always local.
  serverRttMs?: number;
  serverFpsSent?: number;
  serverBitrateBps?: number;
  serverEncodeMs?: number;
  serverDropped?: number;
  targetBitrate?: number;
  targetFps?: number;
  // Server-declared stream metadata — WHAT the server is sending (from the `config` message
  // and per-frame headers), as opposed to the measured metrics above. Populated from the first
  // `config`; kept current by frame headers (e.g. a resize or codec change).
  codec?: string; // e.g. "avc1.42E01F"; absent on the image transport
  colorSpace?: string; // color primaries: "bt709" (sRGB) | "display-p3" | "bt2020"
  frameWidth?: number; // server render resolution (device px)
  frameHeight?: number;
  renderPixelRatio?: number; // device px per CSS px the server renders at
}

export type WorkerToMain =
  | { type: "ready" }
  | { type: "state"; state: ConnectionState }
  | { type: "stats"; stats: Stats }
  // Mode B (feed): a decoded frame transferred to the main thread for the caller to upload.
  | { type: "frame"; frame: VideoFrame | ImageBitmap; frameW: number; frameH: number }
  | {
      type: "capture-result";
      id: number;
      lastDisplayedSeq: number;
      width: number;
      height: number;
      imageData?: ImageData;
      blob?: Blob;
    }
  | { type: "error"; error: string };
