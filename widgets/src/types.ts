// Message contract between the main thread and the decoding worker. Only types
// available in both DOM and WebWorker libs are referenced here.

import type { NormalizedEvent } from "./eventTypes";

export type ConnectionState = "connecting" | "open" | "negotiated" | "closed" | "error";

export interface WorkerInitOptions {
  maxInflight?: number;
  slowDownQueue?: number;
  keyframeOnDropQueue?: number;
  imageOnly?: boolean;
  /** Auth credential forwarded in the `hello` message. */
  token?: string;
}

export type MainToWorker =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      url: string;
      devicePixelRatio: number;
      backingWidth: number;
      backingHeight: number;
      cssWidth: number;
      cssHeight: number;
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
  | { type: "dispose" };

export interface Stats {
  framesDisplayed: number;
  framesDropped: number;
  lastDisplayedSeq: number;
  decodeQueueSize: number;
  transport: "image" | "webcodecs" | "none";
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
}

export type WorkerToMain =
  | { type: "ready" }
  | { type: "state"; state: ConnectionState }
  | { type: "stats"; stats: Stats }
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
