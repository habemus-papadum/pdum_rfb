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
import type { ConnectionState, MainToWorker, Stats, WorkerToMain } from "./types";
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
  /** Auth credential (e.g. a Google OAuth ID token) sent to the server in `hello`. */
  token?: string;
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

  constructor(target: HTMLCanvasElement | HTMLElement, options: RfbViewOptions) {
    this.options = options;
    this.dpr = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    this.canvas = this.resolveCanvas(target);
    this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0;

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
    this.post({ type: "dispose" });
    this.worker.terminate();
    this.captureWaiters.clear();
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
        this.options.onState?.(msg.state);
        break;
      case "stats":
        this._stats = msg.stats;
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
        this.options.onError?.(new Error(msg.error));
        break;
      case "ready":
        break;
    }
  }
}
