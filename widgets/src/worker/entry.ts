// Unified decoding worker: owns the WebSocket, negotiates capabilities, decodes
// image OR video frames (selected per-message by header type), draws to the
// transferred OffscreenCanvas, and handles ACK/backpressure. The main thread
// only captures DOM events and forwards them here.

import { BackpressureController, KeyframeGate } from "../backpressure";
import { probeCapabilities } from "../capabilities";
import type {
  AckMsg,
  HelloMsg,
  ImageFrameHeader,
  RequestKeyframeMsg,
  SetViewportMsg,
  VideoChunkHeader,
} from "../protocol";
import { unpackBinaryMessage } from "../protocol";
import type { NormalizedEvent } from "../eventTypes";
import { applyServerStats, applySetQuality } from "../serverStats";
import type { MainToWorker, Stats, WorkerInitOptions, WorkerToMain } from "../types";
import { backingToFrame } from "../viewport";
import { decodeImageFrame } from "./imageDecode";
import { Renderer } from "./renderer";
import { VideoPipeline } from "./videoDecode";

declare const self: DedicatedWorkerGlobalScope;

let ws: WebSocket | null = null;
let renderer: Renderer | null = null;
let video: VideoPipeline | null = null;
let bp: BackpressureController | null = null;
let cssWidth = 0;
let cssHeight = 0;
let backingWidth = 0;
let backingHeight = 0;
let pixelRatio = 1;
// The frame's render DPR (device px per logical px), from `config`/frame headers;
// echoed on pointer/wheel events so a publisher can recover logical coordinates.
let frameDpr = 1;
let initOptions: WorkerInitOptions = {};

let stats: Stats = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none",
};

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function send(msg: HelloMsg | AckMsg | RequestKeyframeMsg | SetViewportMsg | object): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function requestKeyframe(reason: string): void {
  send({ type: "request_keyframe", reason } satisfies RequestKeyframeMsg);
}

function onDisplayed(seq: number, decodeQueueSize: number): void {
  stats.framesDisplayed += 1;
  stats.lastDisplayedSeq = seq;
  stats.decodeQueueSize = decodeQueueSize;
  send({ type: "ack", seq, decode_queue_size: decodeQueueSize, displayed: true } satisfies AckMsg);
  post({ type: "stats", stats: { ...stats } });
}

/** Map a stream color descriptor to a canvas color space (only P3 vs sRGB matter here). */
function canvasColorSpace(color: unknown): PredefinedColorSpace {
  const primaries = color && typeof color === "object" ? (color as { primaries?: string }).primaries : undefined;
  return primaries === "display-p3" ? "display-p3" : "srgb";
}

/** Map a browser event (CSS canvas coords) to the wire event. Pointer/wheel get their
 *  position remapped CSS -> backing -> frame pixels (via the shared viewport geometry)
 *  plus an `inside` flag and the frame `pixel_ratio` echo; other events pass through. */
function mapEvent(event: NormalizedEvent): NormalizedEvent {
  if (
    event.type === "pointer_move" ||
    event.type === "pointer_down" ||
    event.type === "pointer_up" ||
    event.type === "wheel"
  ) {
    const sx = cssWidth > 0 ? backingWidth / cssWidth : 1;
    const sy = cssHeight > 0 ? backingHeight / cssHeight : 1;
    const { x, y, inside } = backingToFrame(renderer!.viewportState(), event.x * sx, event.y * sy);
    return { ...event, x, y, inside, pixel_ratio: frameDpr };
  }
  return event;
}

function handleControl(control: { type: string; [k: string]: unknown }): void {
  // Server -> client control. `config` advances negotiation and carries the frame's
  // render DPR + color space; `set_quality` and `stats` carry adaptive targets /
  // server-truth metrics we fold into Stats so onStats sees authoritative metrics.
  if (control.type === "config") {
    if (typeof control.pixel_ratio === "number") frameDpr = control.pixel_ratio;
    if (control.color) renderer?.setColorSpace(canvasColorSpace(control.color));
    post({ type: "state", state: "negotiated" });
  } else if (control.type === "set_quality") {
    stats = applySetQuality(stats, control as never);
    post({ type: "stats", stats: { ...stats } });
  } else if (control.type === "stats") {
    stats = applyServerStats(stats, control as never);
    post({ type: "stats", stats: { ...stats } });
  }
}

async function handleBinary(buf: ArrayBuffer): Promise<void> {
  const { header, payload } = unpackBinaryMessage(buf);
  // Frame headers may carry a per-frame render DPR (P2); keep the echo current.
  const framePixelRatio = (header as { pixel_ratio?: unknown }).pixel_ratio;
  if (typeof framePixelRatio === "number") frameDpr = framePixelRatio;
  if (header.type === "image_frame") {
    stats.transport = "image";
    await decodeImageFrame(renderer!, header as ImageFrameHeader, payload);
    onDisplayed((header as ImageFrameHeader).seq, 0);
  } else if (header.type === "video_chunk") {
    stats.transport = "webcodecs";
    video!.handleChunk(header as VideoChunkHeader, payload);
    const q = video!.decodeQueueSize;
    if (bp!.shouldRequestKeyframe(q)) requestKeyframe("decode queue backlog");
  }
}

async function startConnection(url: string): Promise<void> {
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  post({ type: "state", state: "connecting" });

  ws.onopen = async () => {
    post({ type: "state", state: "open" });
    video?.reset();
    const caps = await probeCapabilities({
      width: cssWidth || undefined,
      height: cssHeight || undefined,
      imageOnly: initOptions.imageOnly,
    });
    send({
      type: "hello",
      supported: caps.supported,
      device_pixel_ratio: caps.devicePixelRatio,
      token: initOptions.token, // undefined is dropped by JSON.stringify
    } satisfies HelloMsg);
    // Always announce the initial viewport so the publisher can map logical CSS
    // event coordinates -> its framebuffer from the first frame. Without this the
    // server never learns the CSS size (the ResizeObserver's first callback is a
    // no-op) and falls back to framebuffer size, mis-scaling clicks by the DPR on
    // HiDPI displays.
    if (cssWidth > 0 && cssHeight > 0) {
      send({
        type: "set_viewport",
        width: cssWidth,
        height: cssHeight,
        pwidth: backingWidth,
        pheight: backingHeight,
        ratio: pixelRatio,
      } satisfies SetViewportMsg);
    }
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      handleControl(JSON.parse(ev.data));
      return;
    }
    void handleBinary(ev.data as ArrayBuffer);
  };

  ws.onclose = () => post({ type: "state", state: "closed" });
  ws.onerror = () => post({ type: "error", error: "websocket error" });
}

function handleCapture(id: number, format: "imagedata" | "blob"): void {
  const r = renderer!;
  const base = {
    type: "capture-result" as const,
    id,
    lastDisplayedSeq: stats.lastDisplayedSeq,
    width: r.canvas.width,
    height: r.canvas.height,
  };
  if (format === "blob") {
    void r.toBlob("image/png").then((blob) => post({ ...base, blob }));
  } else {
    const imageData = r.readPixels();
    post({ ...base, imageData }, [imageData.data.buffer]);
  }
}

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init": {
      initOptions = msg.options ?? {};
      cssWidth = msg.cssWidth;
      cssHeight = msg.cssHeight;
      backingWidth = msg.backingWidth;
      backingHeight = msg.backingHeight;
      pixelRatio = msg.devicePixelRatio;
      renderer = new Renderer(msg.canvas);
      if (initOptions.fit) renderer.fit = initOptions.fit;
      if (initOptions.background) renderer.background = initOptions.background;
      renderer.resize(msg.backingWidth, msg.backingHeight);
      bp = new BackpressureController({
        maxInflight: initOptions.maxInflight,
        slowDownQueue: initOptions.slowDownQueue,
        keyframeOnDropQueue: initOptions.keyframeOnDropQueue,
      });
      video = new VideoPipeline(renderer, bp, new KeyframeGate(), requestKeyframe, (seq) =>
        onDisplayed(seq, video!.decodeQueueSize),
      );
      post({ type: "ready" });
      void startConnection(msg.url);
      break;
    }
    case "event":
      send({ type: "event", event: mapEvent(msg.event) });
      break;
    case "set_fit":
      if (renderer) {
        if (msg.fit) renderer.fit = msg.fit;
        if (msg.background !== undefined) renderer.background = msg.background;
      }
      break;
    case "resize":
      cssWidth = msg.cssWidth;
      cssHeight = msg.cssHeight;
      backingWidth = msg.backingWidth;
      backingHeight = msg.backingHeight;
      pixelRatio = msg.pixelRatio;
      renderer?.resize(msg.backingWidth, msg.backingHeight);
      video?.reset();
      send({
        type: "set_viewport",
        width: msg.cssWidth,
        height: msg.cssHeight,
        pwidth: msg.backingWidth,
        pheight: msg.backingHeight,
        ratio: msg.pixelRatio,
      });
      requestKeyframe("viewport resized");
      break;
    case "capture":
      handleCapture(msg.id, msg.format);
      break;
    case "dispose":
      video?.close();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
      break;
  }
};
