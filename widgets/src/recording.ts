// Client-side (browser) recording of exactly what the viewer sees — the on-screen display
// canvas (fit / zoom / pan and all) captured via `HTMLCanvasElement.captureStream()` and
// encoded by a `MediaRecorder` (WebM/MP4 per browser support). This is the symmetric
// counterpart to the server-side `Display.record(...)` tap.
//
// Constraint: `captureStream()` only exists on a real, on-screen `HTMLCanvasElement`. The
// managed-present path that transfers an `OffscreenCanvas` to the decode worker
// (RemoteFramebufferView / Mode A) has NO drawable surface on the main thread, and
// `OffscreenCanvas.captureStream()` is not portable — so recording is only implementable on a
// view that owns a main-thread canvas (MainThreadPresentView). Mode A throws
// RECORDING_UNSUPPORTED_MESSAGE. See docs/guide_javascript.md (Recording).

/** Options for a canvas recording session. */
export interface RecordingOptions {
  /** Preferred container/codec MIME type(s), highest priority first. The first one
   *  `MediaRecorder.isTypeSupported()` accepts wins; if none match (or the field is omitted) a
   *  built-in preference list is tried (VP9 → VP8 → generic WebM → MP4). */
  mimeType?: string | string[];
  /** `captureStream` frame-rate hint (fps). Omit to capture on canvas paint — the present view
   *  redraws on every displayed frame, so the natural cadence tracks the stream (sparse scenes
   *  record sparse frames). */
  frameRate?: number;
  /** Target video bit rate (bits/s) handed to the `MediaRecorder`. */
  videoBitsPerSecond?: number;
  /** `MediaRecorder` `timeslice` (ms) — emit a data chunk every N ms. Default: a single chunk
   *  produced on `stop()`. */
  timeslice?: number;
}

/** A single in-progress recording. `stop()` finalizes the Blob; `cancel()` discards it. */
export interface CanvasRecordingSession {
  /** The negotiated container/codec MIME type (e.g. `"video/webm;codecs=vp9"`). */
  readonly mimeType: string;
  /** True until `stop()` / `cancel()` completes. */
  readonly active: boolean;
  /** Stop recording and resolve with the finalized video Blob. */
  stop(): Promise<Blob>;
  /** Abort without producing a Blob (used by view teardown / `dispose()`). */
  cancel(): void;
}

/** Default MIME preference: VP9 → VP8 → generic WebM (Chromium/Firefox) → MP4 (Safari). */
const DEFAULT_MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
] as const;

/** Actionable message thrown when recording is requested on a view without a main-thread canvas. */
export const RECORDING_UNSUPPORTED_MESSAGE =
  "Client-side recording needs a view that owns an on-screen <canvas>. This view transferred its " +
  "canvas to the decode worker (OffscreenCanvas / Mode A), so the main thread has no drawable " +
  "surface to captureStream(). Use MainThreadPresentView (or the batteries chrome's main-thread " +
  "present path — the anywidget default) to record. See docs/guide_javascript.md (Recording).";

/** Whether this browser can record a canvas: needs `MediaRecorder` + `HTMLCanvasElement.captureStream`. */
export function recordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

/** First supported MIME type from `preferred` (then the built-in list), or undefined if none. */
export function pickRecordingMimeType(preferred?: string | string[]): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  const candidates = [
    ...(preferred ? (Array.isArray(preferred) ? preferred : [preferred]) : []),
    ...DEFAULT_MIME_TYPES,
  ];
  for (const t of candidates) {
    if (t && MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

/**
 * Start recording an on-screen `<canvas>` via `captureStream()` → `MediaRecorder`. Returns a
 * session whose `stop()` resolves the finalized video Blob. Throws if the browser lacks
 * `MediaRecorder` / `captureStream` (guard with {@link recordingSupported}).
 */
export function startCanvasRecording(
  canvas: HTMLCanvasElement,
  options: RecordingOptions = {},
): CanvasRecordingSession {
  if (!recordingSupported()) {
    throw new Error(
      "Canvas recording is unavailable: this browser has no MediaRecorder / HTMLCanvasElement.captureStream().",
    );
  }
  const mimeType = pickRecordingMimeType(options.mimeType);
  const stream = canvas.captureStream(options.frameRate);
  const recorderInit: MediaRecorderOptions = {};
  if (mimeType) recorderInit.mimeType = mimeType;
  if (options.videoBitsPerSecond) recorderInit.videoBitsPerSecond = options.videoBitsPerSecond;

  const recorder = new MediaRecorder(stream, recorderInit);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  let active = true;
  const stopTracks = (): void => {
    for (const track of stream.getTracks()) track.stop();
  };
  const finalize = (): Blob => new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });

  // Start after handlers are wired so a synchronous `dataavailable` can't be missed.
  recorder.start(options.timeslice);

  return {
    get mimeType() {
      return recorder.mimeType || mimeType || "";
    },
    get active() {
      return active;
    },
    stop(): Promise<Blob> {
      if (!active) return Promise.resolve(finalize());
      active = false;
      return new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          stopTracks();
          resolve(finalize());
        };
        recorder.onerror = (ev: Event) => {
          stopTracks();
          reject((ev as unknown as { error?: DOMException }).error ?? new Error("MediaRecorder error"));
        };
        try {
          recorder.stop();
        } catch (e) {
          stopTracks();
          reject(e as Error);
        }
      });
    },
    cancel(): void {
      if (!active) return;
      active = false;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* already stopped */
      }
      stopTracks();
    },
  };
}
