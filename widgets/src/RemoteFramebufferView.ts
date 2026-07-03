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
import { type ObsInstance, readDebugFlag, registerObservable } from "@habemus-papadum/worker-observability/main";

import { type Logger } from "./debug";
import { computeStatus, createStatusOverlay, type StatusOverlayHandle, type StatusRenderer } from "./statusOverlay";
import type { ConnectionState, MainToWorker, Stats, SurfaceKind, SurfacePreference, WorkerToMain } from "./types";
import {
  clampZoom,
  panByBacking,
  presetFraming,
  zoomAround,
  type FitMode,
  type ViewPreset,
  type ViewportFraming,
  type ViewportState,
  type ViewportTransform,
} from "./viewport";
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
  /** Initial zoom multiplier on top of the fit (1 = fit). */
  zoom?: number;
  /** Initial pan offset (backing device px). */
  panX?: number;
  panY?: number;
  /** Enable built-in crop/zoom/pan gestures: wheel zooms toward the cursor, a middle- or
   *  right-button drag pans, and a two-finger pinch zooms/pans. Off by default so pointer /
   *  wheel input passes through to the publisher unchanged; the batteries chrome turns it on
   *  alongside its zoom controls. Left-button drag / clicks still reach the publisher. */
  gestures?: boolean;
  /** Zoom clamp for gestures + `zoomBy` (defaults 0.05 .. 64). */
  minZoom?: number;
  maxZoom?: number;
  /** Compositing backend for the draw path: `"2d"` (default, always available), `"webgl"`,
   *  `"webgpu"`, or `"auto"` (prefer the GPU tiers). Falls back to Canvas2D if the requested
   *  context is unavailable; the active backend is reported on `stats.surface`. Switch it
   *  live with `setSurface()` (rebuilds the view — a canvas context type is immutable). */
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
  /** Fires whenever the viewport framing (fit / zoom / pan) changes — via a gesture, a
   *  preset, or `setViewport` — so chrome can reflect the current zoom. */
  onViewport?: (framing: ViewportFraming) => void;
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
  private target: HTMLCanvasElement | HTMLElement;
  private container: HTMLElement | null = null; // set when we own (create) the canvas
  private ownsCanvas: boolean;
  private canvas!: HTMLCanvasElement;
  private worker!: Worker;
  private options: RfbViewOptions;
  private dpr: number;
  private backingWidth = 0;
  private backingHeight = 0;
  private resizeObserver?: ResizeObserver;
  private captureWaiters = new Map<number, (r: ImageData | Blob) => void>();
  private captureId = 0;
  private _lastCaptureSeq = -1;
  private disposed = false;

  // Viewport framing (client-side crop/zoom/pan) — mirrored on the main thread so gestures
  // and presets compute the next transform locally, then post it to the worker.
  private framing: ViewportFraming;
  private frameW = 0;
  private frameH = 0;
  private readonly minZoom: number;
  private readonly maxZoom: number;

  // Gesture bookkeeping.
  private panPointerId: number | null = null;
  private panLastCss: { x: number; y: number } | null = null;
  private activeTouches = new Map<number, { x: number; y: number }>();
  private pinchPrev: { dist: number; cx: number; cy: number } | null = null;

  private _state: ConnectionState = "connecting";
  private _stats: Stats = { ...EMPTY_STATS };
  private log: Logger;
  // Observability: registers on `window.__rfb`, forwards worker logs into a ring buffer, exposes
  // state/stats/surface/capture snapshots, and flips debug at runtime (worker + this logger).
  private obs: ObsInstance;

  // Status overlay: shown over the canvas during connect / reconnect / disconnect (and until the
  // first frame arrives). A display resize repaints the retained frame in place — no blank — so
  // it needs no overlay state of its own.
  private overlayHost: HTMLElement | null = null;
  private overlay: StatusOverlayHandle | null = null;

  constructor(target: HTMLCanvasElement | HTMLElement, options: RfbViewOptions) {
    this.target = target;
    this.options = options;
    // Register on `window.__rfb` first, then mint the main-thread logger THROUGH it so its lines
    // land in the same ring buffer as the forwarded worker lines, and a runtime `setDebug` flips
    // both. `debug` also honors `?debug=1` / `localStorage.rfbDebug` so a reload can start verbose.
    const debug = options.debug ?? readDebugFlag("rfb");
    this.obs = registerObservable({
      channel: "rfb",
      name: "view",
      debug,
      postToWorker: (m) => this.worker?.postMessage(m),
      snapshots: {
        state: () => this._state,
        stats: () => this._stats,
        surface: () => this._stats.surface,
        capture: () => (fmt: "imagedata" | "blob" = "imagedata") => this.capture(fmt),
      },
    });
    this.log = this.obs.makeLogger("rfb:view", { notice: options.notice ?? true });
    this.log.log("init", { url: options.url, fit: options.fit, imageOnly: options.imageOnly });
    this.dpr = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    this.minZoom = options.minZoom ?? 0.05;
    this.maxZoom = options.maxZoom ?? 64;
    this.framing = {
      fit: options.fit ?? "contain",
      zoom: clampZoom(options.zoom ?? 1, this.minZoom, this.maxZoom),
      panX: options.panX ?? 0,
      panY: options.panY ?? 0,
    };

    this.ownsCanvas = !(target instanceof HTMLCanvasElement);
    if (target instanceof HTMLCanvasElement) {
      this.overlayHost = target.parentElement; // overlay (if any) sits over the canvas in its parent
    } else {
      this.container = target;
      this.overlayHost = target;
    }
    this.setupOverlay();

    this.build();
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

  /** The active display backend (after any fallback), or undefined before the worker builds it. */
  get surface(): SurfaceKind | undefined {
    return this._stats.surface;
  }

  /** Current viewport framing (fit + zoom + pan). */
  getViewport(): ViewportFraming {
    return { ...this.framing };
  }

  /** Change the fit mode (and optionally the letterbox background) on the live view. */
  setFit(fit: FitMode, background?: string): void {
    this.framing.fit = fit;
    if (background !== undefined) this.options.background = background;
    this.post({ type: "set_view", fit, background });
    this.emitViewport();
  }

  /** Apply any subset of the viewport framing (fit / zoom / pan / background). Zoom is
   *  clamped to `[minZoom, maxZoom]`. The retained frame re-presents immediately. */
  setViewport(partial: Partial<ViewportFraming> & { background?: string }): void {
    if (partial.fit) this.framing.fit = partial.fit;
    if (partial.zoom !== undefined) this.framing.zoom = this.clampZ(partial.zoom);
    if (partial.panX !== undefined) this.framing.panX = partial.panX;
    if (partial.panY !== undefined) this.framing.panY = partial.panY;
    if (partial.background !== undefined) this.options.background = partial.background;
    this.post({
      type: "set_view",
      fit: this.framing.fit,
      zoom: this.framing.zoom,
      panX: this.framing.panX,
      panY: this.framing.panY,
      background: partial.background,
    });
    this.emitViewport();
  }

  /** Apply a named preset (`fit` / `cover` / `fill` / `one-to-one`). Thin wrapper over the
   *  general transform. */
  applyPreset(preset: ViewPreset): void {
    this.setViewport(presetFraming(this.viewportStateFor(), preset));
  }

  /** Reset to the default fit (contain, no zoom/pan). */
  resetView(): void {
    this.applyPreset("fit");
  }

  /**
   * Multiply the current zoom by `factor`, keeping the point under `(centerCssX, centerCssY)`
   * (CSS px relative to the viewport; defaults to the canvas center) anchored. Drives the
   * chrome's zoom +/- buttons and wheel gestures.
   */
  zoomBy(factor: number, centerCssX?: number, centerCssY?: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = centerCssX ?? rect.width / 2;
    const cssY = centerCssY ?? rect.height / 2;
    const { bx, by } = this.cssToBacking(cssX, cssY);
    this.applyTransform(zoomAround(this.viewportStateFor(), this.clampZ(this.framing.zoom * factor), bx, by));
  }

  /**
   * Switch the display backend live (`"2d"` / `"webgl"` / `"webgpu"` / `"auto"`). A canvas's
   * context type is immutable once acquired, so this TEARS DOWN and REBUILDS the view/worker
   * with the new preference and RECONNECTS the stream (a brief reconnect flash). Only works
   * when the view owns the canvas (a container target — as the batteries chrome uses); a
   * caller-provided `<canvas>` cannot be switched (its context is already bound).
   */
  setSurface(kind: SurfacePreference): void {
    if (this.disposed) return;
    if (!this.ownsCanvas) {
      this.log.error("surface", "setSurface requires a container target (a canvas context is immutable)");
      return;
    }
    if ((this.options.surface ?? "2d") === kind) return;
    this.options = { ...this.options, surface: kind };
    this.log.notice("surface", "switching backend (rebuild + reconnect):", kind);
    this.teardownWorker();
    this.build();
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
    this.teardownWorker();
    this.overlay?.destroy();
    this.captureWaiters.clear();
    this.obs.dispose();
  }

  // --- build / teardown ---------------------------------------------------

  /** Create (or reuse) the canvas, transfer it, and spin up a worker with the current
   *  surface + framing. Called on construction and on every setSurface() rebuild. */
  private build(): void {
    this.canvas = this.acquireCanvas();
    this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0;

    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width || this.canvas.clientWidth || 320;
    const cssH = rect.height || this.canvas.clientHeight || 240;
    const size = computeBackingSize(cssW, cssH, this.dpr, this.options.maxBackingDimension);
    this.backingWidth = size.backingWidth;
    this.backingHeight = size.backingHeight;
    // Set the backing size BEFORE transferring control to the worker.
    this.canvas.width = size.backingWidth;
    this.canvas.height = size.backingHeight;

    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker = (this.options.workerFactory ?? createInlineWorker)();
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
      // Forwarded worker log lines (observability) land in the ring buffer + re-console here;
      // everything else is a normal worker→main message.
      if (this.obs.ingest(ev.data)) return;
      this.onWorkerMessage(ev.data);
    };

    const init: MainToWorker = {
      type: "init",
      canvas: offscreen,
      url: this.options.url,
      devicePixelRatio: this.dpr,
      backingWidth: size.backingWidth,
      backingHeight: size.backingHeight,
      cssWidth: cssW,
      cssHeight: cssH,
      options: {
        maxInflight: this.options.maxInflight,
        imageOnly: this.options.imageOnly,
        token: this.options.token,
        fit: this.framing.fit,
        background: this.options.background,
        // Carry the current zoom/pan so a rebuild (setSurface) resumes the same framing.
        zoom: this.framing.zoom,
        panX: this.framing.panX,
        panY: this.framing.panY,
        surface: this.options.surface,
        // Seed from the observability instance so `?debug=1`/localStorage (and any runtime
        // rebuild after a setDebug) propagate the current verbosity into the worker.
        debug: this.obs.debug,
        notice: this.options.notice,
      },
    };
    this.worker.postMessage(init, [offscreen]);

    this.attachListeners();
    if (this.options.autoResize !== false) this.observeResize();
  }

  /** Tear down the worker, listeners, and (if we own it) the canvas — without disposing the
   *  overlay, so build() can recreate a fresh canvas in the same host. */
  private teardownWorker(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.detachListeners();
    try {
      this.worker?.postMessage({ type: "dispose" } satisfies MainToWorker);
      this.worker?.terminate();
    } catch {
      /* worker already gone */
    }
    this.panPointerId = null;
    this.panLastCss = null;
    this.activeTouches.clear();
    this.pinchPrev = null;
    if (this.ownsCanvas && this.canvas && this.canvas.parentElement) {
      this.canvas.remove(); // a transferred canvas can't be reused; build() makes a fresh one
    }
  }

  /** Get the canvas to render into: reuse the caller's, or create a fresh one in the container
   *  (a new element each build, because transferControlToOffscreen is one-shot). */
  private acquireCanvas(): HTMLCanvasElement {
    if (!this.ownsCanvas) return this.target as HTMLCanvasElement;
    const container = this.container!;
    const canvas = container.ownerDocument.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    container.appendChild(canvas);
    return canvas;
  }

  // --- internals ----------------------------------------------------------

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
    if (!this.disposed) this.worker?.postMessage(msg);
  }

  private emitViewport(): void {
    this.options.onViewport?.({ ...this.framing });
  }

  private clampZ(zoom: number): number {
    return clampZoom(zoom, this.minZoom, this.maxZoom);
  }

  /** The current geometry state for the main-thread gesture math. */
  private viewportStateFor(): ViewportState {
    return {
      frameW: this.frameW,
      frameH: this.frameH,
      backingW: this.backingWidth,
      backingH: this.backingHeight,
      fit: this.framing.fit,
      zoom: this.framing.zoom,
      panX: this.framing.panX,
      panY: this.framing.panY,
    };
  }

  /** Map a CSS point/delta (relative to the viewport top-left) to backing-store pixels. */
  private cssToBacking(cssX: number, cssY: number): { bx: number; by: number } {
    const rect = this.canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? this.backingWidth / rect.width : 1;
    const sy = rect.height > 0 ? this.backingHeight / rect.height : 1;
    return { bx: cssX * sx, by: cssY * sy };
  }

  private applyTransform(t: ViewportTransform): void {
    this.framing.zoom = t.zoom;
    this.framing.panX = t.panX;
    this.framing.panY = t.panY;
    this.post({ type: "set_view", zoom: t.zoom, panX: t.panX, panY: t.panY });
    this.emitViewport();
  }

  private onPointer = (ev: PointerEvent): void => {
    if (this.options.gestures && this.handlePointerGesture(ev)) return; // consumed by a gesture
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
    if (this.options.gestures) {
      // Wheel zooms toward the cursor; consume it (don't scroll / forward).
      ev.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const { bx, by } = this.cssToBacking(ev.clientX - rect.left, ev.clientY - rect.top);
      const factor = Math.exp(-ev.deltaY * 0.0015); // wheel up (deltaY<0) zooms in
      this.applyTransform(zoomAround(this.viewportStateFor(), this.clampZ(this.framing.zoom * factor), bx, by));
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    this.post({ type: "event", event: normalizeWheelEvent(ev, rect) });
  };

  private onContextMenu = (ev: Event): void => {
    if (this.options.gestures) ev.preventDefault(); // right-drag pans; suppress the menu
  };

  /** Returns true when the pointer event was handled as a pan/pinch gesture (and must NOT be
   *  forwarded to the publisher). Left-button drag / hover / clicks return false and pass
   *  through. Pan = middle- or right-button drag; pinch = two touch pointers. */
  private handlePointerGesture(ev: PointerEvent): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const relX = ev.clientX - rect.left;
    const relY = ev.clientY - rect.top;

    if (ev.pointerType === "touch") return this.handleTouchGesture(ev, relX, relY);

    // Mouse/pen: pan on the middle (buttons&4) or secondary (buttons&2) button.
    const isPanButton = (ev.buttons & 4) !== 0 || (ev.buttons & 2) !== 0;
    if (ev.type === "pointerdown" && isPanButton) {
      this.panPointerId = ev.pointerId;
      this.panLastCss = { x: relX, y: relY };
      try {
        this.canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      ev.preventDefault();
      return true;
    }
    if (this.panPointerId === ev.pointerId) {
      if (ev.type === "pointermove" && this.panLastCss) {
        const dCssX = relX - this.panLastCss.x;
        const dCssY = relY - this.panLastCss.y;
        this.panLastCss = { x: relX, y: relY };
        const { bx, by } = this.cssToBacking(dCssX, dCssY); // deltas scale like points
        this.applyTransform(panByBacking(this.viewportStateFor(), bx, by));
        return true;
      }
      if (ev.type === "pointerup" || ev.type === "pointercancel") {
        this.panPointerId = null;
        this.panLastCss = null;
        return true;
      }
    }
    return false;
  }

  /** Two-finger pinch: distance ratio zooms about the midpoint, midpoint motion pans. A
   *  single touch passes through to the publisher. */
  private handleTouchGesture(ev: PointerEvent, relX: number, relY: number): boolean {
    if (ev.type === "pointerdown") {
      this.activeTouches.set(ev.pointerId, { x: relX, y: relY });
      if (this.activeTouches.size === 2) {
        this.pinchPrev = this.pinchState();
        try {
          this.canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
      }
      return this.activeTouches.size >= 2; // consume once pinching
    }
    if (ev.type === "pointermove" && this.activeTouches.has(ev.pointerId)) {
      this.activeTouches.set(ev.pointerId, { x: relX, y: relY });
      if (this.activeTouches.size === 2 && this.pinchPrev) {
        const now = this.pinchState();
        if (now && this.pinchPrev.dist > 0) {
          const { bx, by } = this.cssToBacking(now.cx, now.cy);
          // Zoom about the midpoint, then translate by the midpoint motion (two-finger drag).
          const zoomed = zoomAround(
            this.viewportStateFor(),
            this.clampZ((this.framing.zoom * now.dist) / this.pinchPrev.dist),
            bx,
            by,
          );
          const dPan = this.cssToBacking(now.cx - this.pinchPrev.cx, now.cy - this.pinchPrev.cy);
          this.applyTransform({ zoom: zoomed.zoom, panX: zoomed.panX + dPan.bx, panY: zoomed.panY + dPan.by });
          this.pinchPrev = now;
        }
        return true;
      }
      return false;
    }
    if (ev.type === "pointerup" || ev.type === "pointercancel") {
      const wasPinching = this.activeTouches.size === 2;
      this.activeTouches.delete(ev.pointerId);
      if (this.activeTouches.size < 2) this.pinchPrev = null;
      return wasPinching;
    }
    return false;
  }

  /** Midpoint + distance of the two active touch points (CSS px). */
  private pinchState(): { dist: number; cx: number; cy: number } | null {
    const pts = [...this.activeTouches.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }

  private onKey = (ev: KeyboardEvent): void => {
    this.post({ type: "event", event: normalizeKeyEvent(ev) });
  };

  private attachListeners(): void {
    this.canvas.addEventListener("pointermove", this.onPointer);
    this.canvas.addEventListener("pointerdown", this.onPointer);
    this.canvas.addEventListener("pointerup", this.onPointer);
    this.canvas.addEventListener("pointercancel", this.onPointer);
    // Non-passive when gestures are on so wheel-zoom can preventDefault the page scroll.
    this.canvas.addEventListener("wheel", this.onWheel, { passive: !this.options.gestures });
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("keydown", this.onKey);
    this.canvas.addEventListener("keyup", this.onKey);
  }

  private detachListeners(): void {
    this.canvas?.removeEventListener("pointermove", this.onPointer);
    this.canvas?.removeEventListener("pointerdown", this.onPointer);
    this.canvas?.removeEventListener("pointerup", this.onPointer);
    this.canvas?.removeEventListener("pointercancel", this.onPointer);
    this.canvas?.removeEventListener("wheel", this.onWheel);
    this.canvas?.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas?.removeEventListener("keydown", this.onKey);
    this.canvas?.removeEventListener("keyup", this.onKey);
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
        // Track the decoded frame size so main-thread gesture math (zoom-to-cursor) is correct.
        if (typeof msg.stats.frameWidth === "number") this.frameW = msg.stats.frameWidth;
        if (typeof msg.stats.frameHeight === "number") this.frameH = msg.stats.frameHeight;
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
