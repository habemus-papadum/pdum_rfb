// Mode B public entry point: stream a server-rendered framebuffer straight into the CALLER's
// own WebGL2 / WebGPU context as a live texture, so the caller composites it into its own
// hardware scene (a windowed frame + a corner minimap + a GUI overlay, all client-side).
//
// Unlike RemoteFramebufferView (Mode A: we own a canvas and present), here the caller owns
// the context and the render loop. We run a decode worker in "feed" mode — it owns the
// WebSocket + decoder and TRANSFERS each decoded frame to this thread — and upload each frame
// into a texture in the caller's context. The caller drives its own requestAnimationFrame
// loop and samples the texture; decode cadence and present cadence are naturally decoupled.

import { makeLogger, type Logger } from "./debug";
import type { ConnectionState, MainToWorker, Stats, WorkerInitOptions, WorkerToMain } from "./types";
import { WebglFrameTexture } from "./webglFrameTexture";
import { WebgpuFrameTexture } from "./webgpuFrameTexture";
import { createInlineWorker } from "./workerFactory";

export interface FrameTextureFeedOptions {
  url: string;
  /** The caller's WebGL2 context (Mode B WebGL). Provide exactly one of `gl` / `device`. */
  gl?: WebGL2RenderingContext;
  /** The caller's WebGPU device (Mode B WebGPU). Provide exactly one of `gl` / `device`. */
  device?: GPUDevice;
  /** Override worker construction (e.g. a URL-based module worker for strict CSP). */
  workerFactory?: () => Worker;
  /** Force the image transport (advertise image-only capabilities). */
  imageOnly?: boolean;
  maxInflight?: number;
  /** Auth credential sent to the server in `hello`. */
  token?: string;
  debug?: boolean;
  notice?: boolean;
  /** Fired after each new frame is uploaded — the caller's cue to (re)render its scene. */
  onFrame?: (info: { frameW: number; frameH: number }) => void;
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

export class FrameTextureFeed {
  readonly kind: "webgl" | "webgpu";
  private worker: Worker;
  private uploader: WebglFrameTexture | WebgpuFrameTexture;
  private options: FrameTextureFeedOptions;
  private log: Logger;
  private _state: ConnectionState = "connecting";
  private _stats: Stats = { ...EMPTY_STATS };
  private disposed = false;

  constructor(options: FrameTextureFeedOptions) {
    this.options = options;
    this.log = makeLogger(options.debug ?? false, "feed", options.notice ?? true);
    if (options.gl) {
      this.kind = "webgl";
      this.uploader = new WebglFrameTexture(options.gl);
    } else if (options.device) {
      this.kind = "webgpu";
      this.uploader = new WebgpuFrameTexture(options.device);
    } else {
      throw new Error("FrameTextureFeed requires a `gl` (WebGL2) or `device` (WebGPU) context");
    }

    this.worker = (options.workerFactory ?? createInlineWorker)();
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.onMessage(ev.data);
    const workerOptions: WorkerInitOptions = {
      maxInflight: options.maxInflight,
      imageOnly: options.imageOnly,
      token: options.token,
      debug: options.debug,
      notice: options.notice,
    };
    const init: MainToWorker = { type: "init", url: options.url, mode: "feed", options: workerOptions };
    this.worker.postMessage(init);
  }

  get state(): ConnectionState {
    return this._state;
  }
  get stats(): Stats {
    return this._stats;
  }
  get frameW(): number {
    return this.uploader.frameW;
  }
  get frameH(): number {
    return this.uploader.frameH;
  }

  /** WebGL Mode B: the live texture to sample in your shaders (null on the WebGPU path). */
  get texture(): WebGLTexture | null {
    return this.uploader.kind === "webgl" ? this.uploader.texture : null;
  }

  /** WebGPU Mode B: a persistent RGBA texture you can sample and retain (null on WebGL). */
  currentTexture(): GPUTexture | null {
    return this.uploader.kind === "webgpu" ? this.uploader.currentTexture() : null;
  }

  /** WebGPU Mode B: a zero-copy external texture for the current VideoFrame — call inside the
   *  render pass that samples it. Null on WebGL, or when the last frame wasn't a VideoFrame. */
  importCurrentFrame(): GPUExternalTexture | null {
    return this.uploader.kind === "webgpu" ? this.uploader.importCurrentFrame() : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.postMessage({ type: "dispose" } satisfies MainToWorker);
    this.worker.terminate();
    this.uploader.dispose();
  }

  private onMessage(msg: WorkerToMain): void {
    switch (msg.type) {
      case "frame":
        // The uploader takes ownership of the transferred frame (copies/holds, then closes).
        this.uploader.upload(msg.frame, msg.frameW, msg.frameH);
        this.options.onFrame?.({ frameW: msg.frameW, frameH: msg.frameH });
        break;
      case "state":
        this._state = msg.state;
        this.log.log("state", msg.state);
        this.options.onState?.(msg.state);
        break;
      case "stats":
        this._stats = msg.stats;
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
