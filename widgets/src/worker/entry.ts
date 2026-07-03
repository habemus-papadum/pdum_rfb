// Unified decoding worker: owns the WebSocket, negotiates capabilities, decodes
// image OR video frames (selected per-message by header type), draws to the
// transferred OffscreenCanvas, and handles ACK/backpressure. The main thread
// only captures DOM events and forwards them here.

import { BackpressureController, KeyframeGate } from "../backpressure";
import { probeCapabilities } from "../capabilities";
import { makeLogger, type Logger } from "../debug";
import type {
  AckMsg,
  HelloMsg,
  ImageFrameHeader,
  RequestKeyframeMsg,
  SetViewportMsg,
  VideoChunkHeader,
} from "../protocol";
import { unpackBinaryMessage } from "../protocol";
import { isPermanentClose, reconnectDelay } from "../reconnect";
import type { NormalizedEvent } from "../eventTypes";
import { applyServerStats, applySetQuality } from "../serverStats";
import type { MainToWorker, Stats, WorkerInitOptions, WorkerToMain } from "../types";
import { backingToFrame } from "../viewport";
import type { FrameSink } from "./frameSink";
import { decodeImageFrame } from "./imageDecode";
import { Renderer } from "./renderer";
import { createDisplaySurface } from "./surfaceFactory";
import { TransferSink } from "./transferSink";
import { VideoPipeline } from "./videoDecode";

declare const self: DedicatedWorkerGlobalScope;

let ws: WebSocket | null = null;
let renderer: Renderer | null = null; // Mode A only (present); null in feed mode
let feedMode = false; // Mode B: frames transferred to main; the main thread owns present geometry
let sink: FrameSink | null = null; // where decoded frames go (renderer, or a TransferSink)
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
let dbg: Logger = makeLogger(false, "worker");
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

// Auto-reconnect state. The server dropping us (a `--dev` reload, a crash, a network blip)
// closes the socket; we reconnect with backoff and re-run the hello/viewport handshake so the
// stream resumes without a page refresh. `disposed` guards our own teardown from looping.
let wsUrl: string | null = null;
let disposed = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

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

let lastKeyframeReason = "";
function requestKeyframe(reason: string): void {
  // Notice the first request of each distinct reason (actionable), but demote consecutive
  // repeats (e.g. "awaiting keyframe" firing on every dropped delta) to the debug stream.
  if (reason !== lastKeyframeReason) dbg.notice("keyframe", "request:", reason);
  else dbg.log("keyframe", "request:", reason);
  lastKeyframeReason = reason;
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

/** Fold server-declared stream metadata (codec / color / resolution / render DPR) from a
 *  `config` message or a frame header into `stats`, so the UI can show WHAT the server sends. */
function applyStreamInfo(h: { codec?: unknown; color?: unknown; width?: unknown; height?: unknown; pixel_ratio?: unknown }): void {
  if (typeof h.codec === "string") stats.codec = h.codec;
  const primaries = h.color && typeof h.color === "object" ? (h.color as { primaries?: string }).primaries : undefined;
  stats.colorSpace = primaries ?? stats.colorSpace ?? "bt709";
  if (typeof h.width === "number") stats.frameWidth = h.width;
  if (typeof h.height === "number") stats.frameHeight = h.height;
  if (typeof h.pixel_ratio === "number") stats.renderPixelRatio = h.pixel_ratio;
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
    dbg.notice("negotiated", {
      transport: control.transport,
      codec: control.codec,
      pixel_ratio: control.pixel_ratio,
      color: control.color,
    });
    if (typeof control.pixel_ratio === "number") frameDpr = control.pixel_ratio;
    if (control.color) renderer?.setColorSpace(canvasColorSpace(control.color));
    applyStreamInfo(control as Parameters<typeof applyStreamInfo>[0]);
    post({ type: "state", state: "negotiated" });
    post({ type: "stats", stats: { ...stats } }); // surface the stream metadata right after negotiation
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
  applyStreamInfo(header as Parameters<typeof applyStreamInfo>[0]); // keep codec/color/resolution current
  if (header.type === "image_frame") {
    const h = header as ImageFrameHeader;
    stats.transport = "image";
    dbg.log("frame", "image", { seq: h.seq, mime: h.mime, bytes: payload.byteLength });
    try {
      await decodeImageFrame(sink!, h, payload);
    } catch (e) {
      dbg.error("decode", "image decode failed", e);
      return;
    }
    onDisplayed(h.seq, 0);
  } else if (header.type === "video_chunk") {
    const h = header as VideoChunkHeader;
    stats.transport = "webcodecs";
    dbg.log("frame", "video", { seq: h.seq, keyframe: h.keyframe, bytes: payload.byteLength });
    video!.handleChunk(h, payload);
    const q = video!.decodeQueueSize;
    if (bp!.shouldRequestKeyframe(q)) requestKeyframe("decode queue backlog");
  }
}

async function startConnection(url: string): Promise<void> {
  dbg.log("ws", "connecting", url);
  wsUrl = url; // remembered so a dropped socket can be reconnected
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  post({ type: "state", state: reconnectAttempts > 0 ? "reconnecting" : "connecting" });

  ws.onopen = async () => {
    dbg.notice("ws", "open");
    reconnectAttempts = 0; // a successful connect resets the backoff ladder
    post({ type: "state", state: "open" });
    video?.reset();
    const caps = await probeCapabilities({
      width: cssWidth || undefined,
      height: cssHeight || undefined,
      imageOnly: initOptions.imageOnly,
    });
    dbg.log("hello", { supported: caps.supported, dpr: caps.devicePixelRatio });
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

  ws.onclose = (ev: CloseEvent) => {
    dbg.notice("ws", "closed", { code: ev.code, reason: ev.reason });
    // Our own teardown or a deliberate server reject (auth/unknown-stream) is terminal;
    // anything else (reload, crash, network blip) is transient — reconnect with backoff.
    if (disposed || isPermanentClose(ev.code)) {
      post({ type: "state", state: "closed" });
      return;
    }
    scheduleReconnect();
  };
  // A transient socket error is always followed by `onclose`, which drives the state and the
  // reconnect — so just log here (posting an error state would flicker during a normal retry).
  ws.onerror = () => {
    dbg.error("ws", "websocket error");
  };
}

/** Reconnect after backoff (unless we've been disposed). Idempotent — a pending timer wins. */
function scheduleReconnect(): void {
  if (disposed || wsUrl === null || reconnectTimer !== null) return;
  const delay = reconnectDelay(reconnectAttempts);
  reconnectAttempts += 1;
  dbg.notice("ws", "reconnect scheduled", { attempt: reconnectAttempts, delayMs: delay });
  post({ type: "state", state: "reconnecting" });
  reconnectTimer = self.setTimeout(() => {
    reconnectTimer = null;
    if (disposed || wsUrl === null) return;
    void startConnection(wsUrl);
  }, delay);
}

function handleCapture(id: number, format: "imagedata" | "blob"): void {
  const r = renderer;
  if (!r) return; // capture before the renderer is built (init still resolving)
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
    void r.readPixels().then((imageData) => post({ ...base, imageData }, [imageData.data.buffer]));
  }
}

/** The async tail of `init`: build the frame sink (present: a Renderer over a chosen draw
 *  path, async for WebGPU; feed: a TransferSink that ships frames to the main thread), then
 *  wire backpressure, the video pipeline, and start the connection. Split out so the message
 *  handler stays synchronous. */
async function buildRenderer(msg: Extract<MainToWorker, { type: "init" }>): Promise<void> {
  if (msg.mode === "feed") {
    // Mode B: no canvas, no present — decoded frames are transferred to the main thread (a
    // caller's GPU texture via FrameTextureFeed, or a main-thread 2D present via
    // MainThreadPresentView). Either way the MAIN THREAD owns the present geometry.
    feedMode = true;
    sink = new TransferSink((m, transfer) => post(m, transfer));
    stats.transport = "none";
    dbg.log("mode", "feed (frame-as-texture)");
  } else {
    // Mode A: pick the draw path (Canvas2D floor / WebGL2 / WebGPU). Falls back to 2D if the
    // requested GPU context is unavailable; report what we got.
    const surface = await createDisplaySurface(msg.canvas!, initOptions.surface);
    if (disposed) {
      surface.dispose(); // disposed while we were awaiting the device — don't wire anything up
      return;
    }
    renderer = new Renderer(msg.canvas!, surface);
    sink = renderer;
    stats.surface = surface.kind;
    if (surface.kind !== (initOptions.surface ?? "2d") && initOptions.surface && initOptions.surface !== "auto") {
      dbg.notice("surface", `requested ${initOptions.surface}, using ${surface.kind} (fallback)`);
    } else {
      dbg.log("surface", "backend", surface.kind);
    }
    if (initOptions.fit) renderer.fit = initOptions.fit;
    if (initOptions.background) renderer.background = initOptions.background;
    renderer.resize(msg.backingWidth ?? 0, msg.backingHeight ?? 0);
  }
  if (disposed) {
    sink.dispose();
    return;
  }
  bp = new BackpressureController({
    maxInflight: initOptions.maxInflight,
    slowDownQueue: initOptions.slowDownQueue,
    keyframeOnDropQueue: initOptions.keyframeOnDropQueue,
  });
  video = new VideoPipeline(
    sink,
    bp,
    new KeyframeGate(),
    requestKeyframe,
    (seq) => onDisplayed(seq, video!.decodeQueueSize),
    dbg,
    {
      onDecoderReset: () => {
        dbg.notice("recover", "decoder reset — asking server to clear inflight");
        send({ type: "decoder_reset" });
      },
      onRecovered: () => {
        stats.recoveries = (stats.recoveries ?? 0) + 1;
        post({ type: "stats", stats: { ...stats } });
      },
      onFatal: (message) => post({ type: "error", error: message }),
    },
  );
  // Stall watchdog: a decoder that stops emitting output must not brick the viewer.
  watchdogTimer = self.setInterval(() => video?.checkStall(), 500);
  post({ type: "ready" });
  post({ type: "stats", stats: { ...stats } }); // surface the chosen backend immediately
  void startConnection(msg.url);
}

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init": {
      initOptions = msg.options ?? {};
      dbg = makeLogger(!!initOptions.debug, "worker", initOptions.notice ?? true);
      dbg.log("init", { backing: [msg.backingWidth, msg.backingHeight], dpr: msg.devicePixelRatio });
      cssWidth = msg.cssWidth ?? 0;
      cssHeight = msg.cssHeight ?? 0;
      backingWidth = msg.backingWidth ?? 0;
      backingHeight = msg.backingHeight ?? 0;
      pixelRatio = msg.devicePixelRatio ?? 1;
      // Building the surface is async (WebGPU device acquisition), so the rest of init runs
      // after it resolves. Messages arriving in that (tiny) gap are guarded against a null
      // renderer below.
      void buildRenderer(msg);
      break;
    }
    case "event":
      // Present mode (Mode A): map CSS -> frame pixels here — the renderer owns the geometry.
      // Feed mode (Mode B): the main thread owns the geometry and already mapped the event, so
      // forward it verbatim (a plain FrameTextureFeed simply never posts events).
      if (renderer) send({ type: "event", event: mapEvent(msg.event) });
      else if (feedMode) send({ type: "event", event: msg.event });
      break;
    case "set_fit":
      if (renderer) {
        if (msg.fit) renderer.fit = msg.fit;
        if (msg.background !== undefined) renderer.background = msg.background;
        renderer.redraw(); // apply the new fit/background to the current frame immediately
      }
      break;
    case "resize":
      dbg.notice("resize", { backing: [msg.backingWidth, msg.backingHeight], css: [msg.cssWidth, msg.cssHeight] });
      cssWidth = msg.cssWidth;
      cssHeight = msg.cssHeight;
      backingWidth = msg.backingWidth;
      backingHeight = msg.backingHeight;
      pixelRatio = msg.pixelRatio;
      // A display-only resize (CSS/DPR): the incoming stream resolution is unchanged, so the
      // decoder keeps running and we just repaint the retained frame at the new canvas size —
      // no reset, no keyframe request, no blank. If the server chooses to resize its framebuffer
      // (match_client policy), the client reconfigures reactively when the new-size keyframe
      // arrives. `set_viewport` stays informational (event-coordinate mapping + that policy).
      renderer?.resize(msg.backingWidth, msg.backingHeight);
      send({
        type: "set_viewport",
        width: msg.cssWidth,
        height: msg.cssHeight,
        pwidth: msg.backingWidth,
        pheight: msg.backingHeight,
        ratio: msg.pixelRatio,
      });
      break;
    case "capture":
      handleCapture(msg.id, msg.format);
      break;
    case "dispose":
      disposed = true; // stop any in-flight reconnect from firing after teardown
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (watchdogTimer !== null) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      video?.close();
      sink?.dispose();
      renderer = null;
      sink = null;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
      break;
  }
};
