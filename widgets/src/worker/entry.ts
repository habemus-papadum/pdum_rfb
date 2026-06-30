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
import { applyServerStats, applySetQuality } from "../serverStats";
import type { MainToWorker, Stats, WorkerInitOptions, WorkerToMain } from "../types";
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

function handleControl(control: { type: string; [k: string]: unknown }): void {
  // Server -> client control. `config` advances negotiation; `set_quality` and
  // `stats` carry adaptive targets / server-truth metrics we fold into Stats so
  // the app's onStats sees authoritative RTT, fps, and bitrate.
  if (control.type === "config") {
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
      renderer = new Renderer(msg.canvas);
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
      send({ type: "event", event: msg.event });
      break;
    case "resize":
      cssWidth = msg.cssWidth;
      cssHeight = msg.cssHeight;
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
