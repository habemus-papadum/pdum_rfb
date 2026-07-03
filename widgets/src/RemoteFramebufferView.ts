// The single public, framework-agnostic class. Construct it with a canvas (or a
// container to fill) and a ws URL; it owns the worker, forwards normalized DOM
// events, and tears everything down on dispose(). Frameworks instantiate it in
// a mount/effect and call dispose() on cleanup.

import {
  computeBackingSize,
  normalizeKeyEvent,
  normalizePointerEvent,
  normalizeWheelEvent,
} from "./events";
import { makeLogger, type Logger } from "./debug";
import { computeStatus, createStatusOverlay, type StatusOverlayHandle, type StatusRenderer } from "./statusOverlay";
import type { ConnectionState, MainToWorker, Stats, SurfacePreference, WorkerToMain } from "./types";
import type { FitMode } from "./viewport";
import { createInlineWorker } from "./workerFactory";

export interface RfbViewOptions {
  url: string;
  /** Override worker construction (e.g. a URL-based module worker for strict CSP). */
  workerFactory?: () => Worker;
  autoResize?: boolean;
  devicePixelRatio?: number;
  maxBackingDimension?: number;
  /** Force the image transport (advertise image-only capabilities). */
  imageOnly?: boolean;
  maxInflight?: number;
  /** How the frame fits the canvas when their aspect ratios differ. Default `"contain"`
   *  (letterbox, no distortion); `"cover"` crops; `"fill"` stretches each axis. */
  fit?: FitMode;
  /** Letterbox fill color for `"contain"` (any CSS color; default `"#000"`). */
  background?: string;
  /** Compositing backend for the draw path: `"2d"` (default, always available), `"webgl"`,
   *  or `"auto"` (prefer the GPU tiers). Falls back to Canvas2D if the requested context is
   *  unavailable; the active backend is reported on `stats.surface`. */
  surface?: SurfacePreference;
  /** Auth credential (e.g. a Google OAuth ID token) sent to the server in `hello`. */
  token?: string;
  /** Verbose client-side console logging (per-frame decode play-by-play). Genuine errors and
   *  lifecycle notices surface either way; this adds the firehose. Default `false`. */
  debug?: boolean;
  /** Lifecycle `notice()` logging — WS open/close/reconnect, negotiation, keyframe requests,
   *  backpressure, decoder reset/recovery, resize. Rare + actionable, not per-frame. Default
   *  `true`; set `false` for a silent console (errors still show). */
  notice?: boolean;
  onState?: (state: ConnectionState) => void;
  onStats?: (stats: Stats) => void;
  onError?: (err: Error) => void;
  /** On-canvas status overlay (connecting / reconnecting / disconnected, and the brief gap
   *  after a resize while the decoder resets and awaits a keyframe). `false` disables it; a
   *  render function fully customizes its DOM. Default: a built-in spinner + label. Needs a
   *  positioned host (a container target, or a canvas with a parent) — otherwise it no-ops. */
  statusOverlay?: false | StatusRenderer;
}

const EMPTY_STATS: Stats = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none",
};

export class RemoteFramebufferView {
  private canvas: HTMLCanvasElement;
  private worker: Worker;
  private options: RfbViewOptions;
  private dpr: number;
  private backingWidth = 0;
  private backingHeight = 0;
  private resizeObserver?: ResizeObserver;
  private captureWaiters = new Map<number, (r: ImageData | Blob) => void>();
  private captureId = 0;
  private _lastCaptureSeq = -1;
  private disposed = false;

  private _state: ConnectionState = "connecting";
  private _stats: Stats = { ...EMPTY_STATS };
  private log: Logger;

  // Status overlay: shown over the canvas during connect / reconnect / disconnect (and until the
  // first frame arrives). A display resize repaints the retained frame in place — no blank — so
  // it needs no overlay state of its own.
  private overlayHost: HTMLElement | null = null;
  private overlay: StatusOverlayHandle | null = null;

  constructor(target: HTMLCanvasElement | HTMLElement, options: RfbViewOptions) {
    this.options = options;
    this.log = makeLogger(options.debug ?? false, "view", options.notice ?? true);
    this.log.log("init", { url: options.url, fit: options.fit, imageOnly: options.imageOnly });
    this.dpr = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    this.canvas = this.resolveCanvas(target);
    this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0;
    this.setupOverlay();

    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width || this.canvas.clientWidth || 320;
    const cssH = rect.height || this.canvas.clientHeight || 240;
    const size = computeBackingSize(cssW, cssH, this.dpr, options.maxBackingDimension);
    this.backingWidth = size.backingWidth;
    this.backingHeight = size.backingHeight;
    // Set the backing size BEFORE transferring control to the worker.
    this.canvas.width = size.backingWidth;
    this.canvas.height = size.backingHeight;

    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker = (options.workerFactory ?? createInlineWorker)();
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.onWorkerMessage(ev.data);

    const init: MainToWorker = {
      type: "init",
      canvas: offscreen,
      url: options.url,
      devicePixelRatio: this.dpr,
      backingWidth: size.backingWidth,
      backingHeight: size.backingHeight,
      cssWidth: cssW,
      cssHeight: cssH,
      options: {
        maxInflight: options.maxInflight,
        imageOnly: options.imageOnly,
        token: options.token,
        fit: options.fit,
        background: options.background,
        surface: options.surface,
        debug: options.debug,
        notice: options.notice,
      },
    };
    this.worker.postMessage(init, [offscreen]);

    this.attachListeners();
    if (options.autoResize !== false) this.observeResize();
  }

  get state(): ConnectionState {
    return this._state;
  }

  get stats(): Stats {
    return this._stats;
  }

  /** Seq of the frame measured by the most recent capture() (debug/test hook). */
  get lastCaptureSeq(): number {
    return this._lastCaptureSeq;
  }

  /** Change the fit mode (and optionally the letterbox background) on the live view. */
  setFit(fit: FitMode, background?: string): void {
    this.post({ type: "set_fit", fit, background });
  }

  capture(format: "imagedata" | "blob" = "imagedata"): Promise<ImageData | Blob> {
    const id = ++this.captureId;
    return new Promise((resolve) => {
      this.captureWaiters.set(id, resolve);
      this.post({ type: "capture", id, format });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.detachListeners();
    this.overlay?.destroy();
    this.post({ type: "dispose" });
    this.worker.terminate();
    this.captureWaiters.clear();
  }

  // --- internals ----------------------------------------------------------

  private resolveCanvas(target: HTMLCanvasElement | HTMLElement): HTMLCanvasElement {
    if (target instanceof HTMLCanvasElement) {
      this.overlayHost = target.parentElement; // overlay (if any) sits over the canvas in its parent
      return target;
    }
    const canvas = target.ownerDocument.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    target.appendChild(canvas);
    this.overlayHost = target; // we own this container — overlay is a sibling of the canvas in it
    return canvas;
  }

  /** Mount the on-canvas status overlay (unless disabled or no positioned host is available). */
  private setupOverlay(): void {
    if (this.options.statusOverlay === false || !this.overlayHost) return;
    // The overlay is absolutely positioned; give it a positioned offset parent if the host is
    // still `static` (relative doesn't change flow, so this is layout-safe).
    if (getComputedStyle(this.overlayHost).position === "static") {
      this.overlayHost.style.position = "relative";
    }
    const render = typeof this.options.statusOverlay === "function" ? this.options.statusOverlay : undefined;
    this.overlay = createStatusOverlay(this.overlayHost, render);
    this.refreshStatus();
  }

  /** Recompute + apply the overlay status from the current connection state / frame count. */
  private refreshStatus(): void {
    this.overlay?.update(computeStatus(this._state, this._stats.framesDisplayed));
  }

  private post(msg: MainToWorker): void {
    if (!this.disposed) this.worker.postMessage(msg);
  }

  private onPointer = (ev: PointerEvent): void => {
    if (ev.type === "pointerdown") {
      this.canvas.focus();
      try {
        this.canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    }
    const rect = this.canvas.getBoundingClientRect();
    this.post({ type: "event", event: normalizePointerEvent(ev, rect) });
  };

  private onWheel = (ev: WheelEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.post({ type: "event", event: normalizeWheelEvent(ev, rect) });
  };

  private onKey = (ev: KeyboardEvent): void => {
    this.post({ type: "event", event: normalizeKeyEvent(ev) });
  };

  private attachListeners(): void {
    this.canvas.addEventListener("pointermove", this.onPointer);
    this.canvas.addEventListener("pointerdown", this.onPointer);
    this.canvas.addEventListener("pointerup", this.onPointer);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: true });
    this.canvas.addEventListener("keydown", this.onKey);
    this.canvas.addEventListener("keyup", this.onKey);
  }

  private detachListeners(): void {
    this.canvas.removeEventListener("pointermove", this.onPointer);
    this.canvas.removeEventListener("pointerdown", this.onPointer);
    this.canvas.removeEventListener("pointerup", this.onPointer);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("keydown", this.onKey);
    this.canvas.removeEventListener("keyup", this.onKey);
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.dpr = this.options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
      const size = computeBackingSize(
        rect.width,
        rect.height,
        this.dpr,
        this.options.maxBackingDimension,
      );
      if (size.backingWidth === this.backingWidth && size.backingHeight === this.backingHeight) {
        return;
      }
      this.backingWidth = size.backingWidth;
      this.backingHeight = size.backingHeight;
      this.post({
        type: "resize",
        backingWidth: size.backingWidth,
        backingHeight: size.backingHeight,
        cssWidth: rect.width,
        cssHeight: rect.height,
        pixelRatio: size.pixelRatio,
      });
    });
    this.resizeObserver.observe(this.canvas);
  }

  private onWorkerMessage(msg: WorkerToMain): void {
    switch (msg.type) {
      case "state":
        this._state = msg.state;
        this.log.log("state", msg.state);
        this.refreshStatus();
        this.options.onState?.(msg.state);
        break;
      case "stats":
        this._stats = msg.stats;
        this.refreshStatus();
        this.options.onStats?.(msg.stats);
        break;
      case "capture-result": {
        this._lastCaptureSeq = msg.lastDisplayedSeq;
        const resolve = this.captureWaiters.get(msg.id);
        if (resolve) {
          this.captureWaiters.delete(msg.id);
          resolve(msg.imageData ?? (msg.blob as Blob));
        }
        break;
      }
      case "error":
        this._state = "error";
        this.log.error("worker", msg.error);
        this.options.onError?.(new Error(msg.error));
        break;
      case "ready":
        break;
    }
  }
}
