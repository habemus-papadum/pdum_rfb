// A managed-present controller (like RemoteFramebufferView) that draws on the MAIN THREAD
// instead of transferring an OffscreenCanvas to the worker. It runs the decode worker in
// Mode B "feed": the worker owns the WebSocket + decoder and TRANSFERS each decoded frame
// (VideoFrame | ImageBitmap) to this thread, and we draw it into a normal `<canvas>` with a
// 2D `drawImage` on receipt.
//
// Why it exists: the OffscreenCanvas transfer path (RemoteFramebufferView / Mode A) is
// fragile inside embedding hosts that reparent/re-render the widget subtree AFTER
// `transferControlToOffscreen()` — notably marimo, which renders the anywidget in a shadow
// root and re-runs the output cell on state changes, severing the placeholder→compositor
// link so the worker keeps drawing into an orphaned surface and the on-screen canvas stays
// black (see docs/proposals/active/marimo_rendering_fix.md). A plain main-thread canvas has
// no transferred placeholder to sever: the framework may move it freely and the next
// `drawImage` composites into wherever it now lives. The cost is a per-frame frame transfer
// + main-thread draw, which is negligible at notebook cadence.
//
// This keeps a small superset of RemoteFramebufferView's surface (constructor, dispose,
// capture, setFit) so callers can use either interchangeably. Unlike Mode A, the frame
// geometry (fit / letterbox / event coordinate mapping) lives HERE on the main thread — the
// feed-mode worker has no renderer — so events are normalized and mapped to frame pixels
// here, then forwarded to the worker verbatim.

import { type ObsInstance, readDebugFlag, registerObservable } from "@habemus-papadum/worker-observability/main";

import { type Logger } from "./debug";
import {
  computeBackingSize,
  normalizeKeyEvent,
  normalizePointerEvent,
  normalizeWheelEvent,
} from "./events";
import type { NormalizedEvent } from "./eventTypes";
import type { ConnectionState, MainToWorker, Stats, WorkerInitOptions, WorkerToMain } from "./types";
import { backingToFrame, presentGeometry, type FitMode, type ViewportState } from "./viewport";
import { createInlineWorker } from "./workerFactory";

export interface MainThreadPresentOptions {
  url: string;
  /** Override worker construction (e.g. a URL-based module worker for strict CSP). */
  workerFactory?: () => Worker;
  autoResize?: boolean;
  devicePixelRatio?: number;
  maxBackingDimension?: number;
  /** Force the image transport (advertise image-only capabilities). */
  imageOnly?: boolean;
  maxInflight?: number;
  /** How the frame fits the canvas when their aspect ratios differ. Default `"contain"`. */
  fit?: FitMode;
  /** Letterbox fill color for `"contain"` (any CSS color; default `"#000"`). */
  background?: string;
  /** Auth credential sent to the server in `hello`. */
  token?: string;
  debug?: boolean;
  notice?: boolean;
  onState?: (state: ConnectionState) => void;
  onStats?: (stats: Stats) => void;
  onError?: (err: Error) => void;
}

const EMPTY_STATS: Stats = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none",
};

/** Close a decoded source if it is closeable (VideoFrame / ImageBitmap). */
function closeFrame(src: { close?: () => void } | null): void {
  src?.close?.();
}

export class MainThreadPresentView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private worker: Worker;
  private options: MainThreadPresentOptions;
  private log: Logger;
  // Observability: registers on `window.__rfb`, forwards worker logs, exposes snapshots, and
  // flips debug at runtime. `capture()` here reads the on-screen main-thread canvas (§7.4).
  private obs: ObsInstance;
  private dpr: number;

  private backingWidth = 0;
  private backingHeight = 0;

  private fit: FitMode;
  private background: string;

  // Current decoded frame size + a native-resolution retained copy, so a display resize / fit
  // change repaints the last picture WITHOUT waiting for the next frame (mirrors Canvas2dSurface).
  private frameW = 0;
  private frameH = 0;
  private retained: OffscreenCanvas | null = null;
  private retainedCtx: OffscreenCanvasRenderingContext2D | null = null;
  // The frame's render DPR, echoed on pointer/wheel events (from stats.renderPixelRatio).
  private renderDpr = 1;

  private resizeObserver?: ResizeObserver;
  private disposed = false;

  private _state: ConnectionState = "connecting";
  private _stats: Stats = { ...EMPTY_STATS };

  constructor(target: HTMLCanvasElement | HTMLElement, options: MainThreadPresentOptions) {
    this.options = options;
    const debug = options.debug ?? readDebugFlag("rfb");
    this.obs = registerObservable({
      channel: "rfb",
      name: "present-main",
      debug,
      postToWorker: (m) => this.worker?.postMessage(m),
      snapshots: {
        state: () => this._state,
        stats: () => this._stats,
        surface: () => this._stats.surface,
        capture: () => (fmt: "imagedata" | "blob" = "imagedata") => this.capture(fmt),
      },
    });
    this.log = this.obs.makeLogger("rfb:present-main", { notice: options.notice ?? true });
    this.log.log("init", { url: options.url, fit: options.fit, imageOnly: options.imageOnly });
    this.fit = options.fit ?? "contain";
    this.background = options.background ?? "#000";
    this.dpr = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    this.canvas = this.resolveCanvas(target);
    this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0;

    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width || this.canvas.clientWidth || 320;
    const cssH = rect.height || this.canvas.clientHeight || 240;
    const size = computeBackingSize(cssW, cssH, this.dpr, options.maxBackingDimension);
    this.backingWidth = size.backingWidth;
    this.backingHeight = size.backingHeight;
    this.canvas.width = size.backingWidth;
    this.canvas.height = size.backingHeight;
    // The 2D context stays on the main thread — this canvas is NEVER transferred, so the
    // framework can reparent it and the next present() draws into its new location.
    this.ctx = this.canvas.getContext("2d");

    this.worker = (options.workerFactory ?? createInlineWorker)();
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
      // Forwarded worker log lines (observability) land in the ring buffer + re-console here.
      if (this.obs.ingest(ev.data)) return;
      this.onWorkerMessage(ev.data);
    };
    const workerOptions: WorkerInitOptions = {
      maxInflight: options.maxInflight,
      imageOnly: options.imageOnly,
      token: options.token,
      debug: this.obs.debug, // honor ?debug=1 / localStorage.rfbDebug
      notice: options.notice,
    };
    const init: MainToWorker = {
      type: "init",
      url: options.url,
      mode: "feed", // no OffscreenCanvas transfer — frames are shipped back to us
      devicePixelRatio: this.dpr,
      backingWidth: size.backingWidth,
      backingHeight: size.backingHeight,
      cssWidth: cssW,
      cssHeight: cssH,
      options: workerOptions,
    };
    this.worker.postMessage(init);

    this.attachListeners();
    if (options.autoResize !== false) this.observeResize();
  }

  get state(): ConnectionState {
    return this._state;
  }
  get stats(): Stats {
    return this._stats;
  }

  /** Change the fit mode (and optionally the letterbox background) on the live view. */
  setFit(fit: FitMode, background?: string): void {
    this.fit = fit;
    if (background !== undefined) this.background = background;
    this.present(); // repaint the retained frame at the new fit immediately
  }

  /** Read the composited MAIN-THREAD canvas back (the on-screen surface — the ground truth
   *  for whether pixels actually reach the compositor, unlike Mode A's worker-surface capture). */
  capture(format: "imagedata" | "blob" = "imagedata"): Promise<ImageData | Blob> {
    if (format === "blob") {
      return new Promise((resolve, reject) => {
        this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
      });
    }
    if (!this.ctx) return Promise.reject(new Error("2D context unavailable"));
    return Promise.resolve(this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.detachListeners();
    this.worker.postMessage({ type: "dispose" } satisfies MainToWorker);
    this.worker.terminate();
    this.retained = null; // an OffscreenCanvas — GC'd once unreferenced (no close() needed)
    this.retainedCtx = null;
    this.obs.dispose();
  }

  // --- internals ----------------------------------------------------------

  private resolveCanvas(target: HTMLCanvasElement | HTMLElement): HTMLCanvasElement {
    if (target instanceof HTMLCanvasElement) return target;
    const canvas = target.ownerDocument.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    target.appendChild(canvas);
    return canvas;
  }

  private viewportState(): ViewportState {
    return {
      frameW: this.frameW,
      frameH: this.frameH,
      backingW: this.canvas.width,
      backingH: this.canvas.height,
      fit: this.fit,
    };
  }

  /** Draw a transferred frame: retain a native-res copy (for repaint-on-resize), then present. */
  private drawFrame(src: VideoFrame | ImageBitmap, frameW: number, frameH: number): void {
    try {
      this.frameW = frameW;
      this.frameH = frameH;
      if (!this.retained || this.retained.width !== frameW || this.retained.height !== frameH) {
        this.retained = new OffscreenCanvas(frameW, frameH);
        this.retainedCtx = this.retained.getContext("2d");
      }
      this.retainedCtx?.drawImage(src, 0, 0, frameW, frameH);
      this.present();
    } finally {
      closeFrame(src); // we own the transferred frame; copied into `retained`, so release it
    }
  }

  /** Repaint the retained frame with the current size/fit + background (no-op if none yet). */
  private present(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Clear to the background first so `contain` letterbox bars / a shrink on resize don't
    // show stale pixels; `fill`/`cover` overpaint it entirely.
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.retained && this.frameW > 0) {
      const { src, dst } = presentGeometry(this.viewportState());
      ctx.drawImage(this.retained, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
    }
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
    this.sendEvent(normalizePointerEvent(ev, rect), rect);
  };

  private onWheel = (ev: WheelEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.sendEvent(normalizeWheelEvent(ev, rect), rect);
  };

  private onKey = (ev: KeyboardEvent): void => {
    this.post({ type: "event", event: normalizeKeyEvent(ev) });
  };

  /** Map a pointer/wheel event's CSS coords -> backing -> frame pixels (the feed-mode worker
   *  has no renderer to do this), then forward it. Keys pass through unmapped. */
  private sendEvent(event: NormalizedEvent, rect: DOMRect): void {
    if (
      event.type === "pointer_move" ||
      event.type === "pointer_down" ||
      event.type === "pointer_up" ||
      event.type === "wheel"
    ) {
      const sx = rect.width > 0 ? this.canvas.width / rect.width : 1;
      const sy = rect.height > 0 ? this.canvas.height / rect.height : 1;
      const { x, y, inside } = backingToFrame(this.viewportState(), event.x * sx, event.y * sy);
      this.post({ type: "event", event: { ...event, x, y, inside, pixel_ratio: this.renderDpr } });
    } else {
      this.post({ type: "event", event });
    }
  }

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
      const size = computeBackingSize(rect.width, rect.height, this.dpr, this.options.maxBackingDimension);
      if (size.backingWidth === this.backingWidth && size.backingHeight === this.backingHeight) return;
      this.backingWidth = size.backingWidth;
      this.backingHeight = size.backingHeight;
      // Resize the backing store (clears it) then repaint the retained frame so the display
      // resize doesn't flash blank — no decoder reset (the stream resolution is unchanged).
      this.canvas.width = size.backingWidth;
      this.canvas.height = size.backingHeight;
      this.present();
      // Inform the worker/server (informational set_viewport; keeps event mapping + any
      // match_client resize policy in sync).
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
      case "frame":
        this.drawFrame(msg.frame, msg.frameW, msg.frameH);
        break;
      case "state":
        this._state = msg.state;
        this.log.log("state", msg.state);
        this.options.onState?.(msg.state);
        break;
      case "stats":
        this._stats = msg.stats;
        if (typeof msg.stats.renderPixelRatio === "number") this.renderDpr = msg.stats.renderPixelRatio;
        this.options.onStats?.(msg.stats);
        break;
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
