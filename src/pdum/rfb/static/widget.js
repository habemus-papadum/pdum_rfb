var q = Object.defineProperty;
var O = (t, e, n) => e in t ? q(t, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : t[e] = n;
var h = (t, e, n) => O(t, typeof e != "symbol" ? e + "" : e, n);
function w(t) {
  const e = [];
  return t.shiftKey && e.push("Shift"), t.ctrlKey && e.push("Control"), t.altKey && e.push("Alt"), t.metaKey && e.push("Meta"), e;
}
function P(t) {
  switch (t) {
    case 0:
      return 1;
    // left
    case 1:
      return 3;
    // middle
    case 2:
      return 2;
    // right
    case 3:
      return 4;
    // back
    case 4:
      return 5;
    // forward
    default:
      return 0;
  }
}
function D(t) {
  const e = [];
  return t & 1 && e.push(1), t & 2 && e.push(2), t & 4 && e.push(3), t & 8 && e.push(4), t & 16 && e.push(5), e;
}
function L(t, e, n) {
  return { x: t - n.left, y: e - n.top };
}
function S(t, e, n) {
  return e === 1 ? t * 16 : e === 2 ? t * n : t;
}
function T(t, e) {
  const { x: n, y: s } = L(t.clientX, t.clientY, e);
  return {
    type: t.type === "pointerdown" ? "pointer_down" : t.type === "pointerup" ? "pointer_up" : "pointer_move",
    x: n,
    y: s,
    button: P(t.button),
    buttons: D(t.buttons),
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function F(t, e) {
  const { x: n, y: s } = L(t.clientX, t.clientY, e);
  return {
    type: "wheel",
    x: n,
    y: s,
    dx: S(t.deltaX, t.deltaMode, e.width),
    dy: S(t.deltaY, t.deltaMode, e.height),
    buttons: D(t.buttons),
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function B(t) {
  return {
    type: t.type === "keydown" ? "key_down" : "key_up",
    key: t.key,
    code: t.code,
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function _(t, e, n, s) {
  let i = Math.max(1, Math.round(t * n)), a = Math.max(1, Math.round(e * n)), c = n;
  if (s && Math.max(i, a) > s) {
    const o = s / Math.max(i, a);
    i = Math.max(1, Math.round(i * o)), a = Math.max(1, Math.round(a * o)), c = t > 0 ? i / t : n;
  }
  return { backingWidth: i, backingHeight: a, pixelRatio: c };
}
const C = `var q = Object.defineProperty;
var C = (t, e, i) => e in t ? q(t, e, { enumerable: !0, configurable: !0, writable: !0, value: i }) : t[e] = i;
var n = (t, e, i) => C(t, typeof e != "symbol" ? e + "" : e, i);
const R = {
  maxInflight: 3,
  slowDownQueue: 3,
  keyframeOnDropQueue: 6
};
class Q {
  constructor(e = {}) {
    n(this, "cfg");
    n(this, "queued", []);
    this.cfg = { ...R, ...e };
  }
  onQueued(e) {
    this.queued.push(e);
  }
  /** Mark the oldest queued frame as displayed; returns its seq (or undefined). */
  onDisplayed() {
    return this.queued.shift();
  }
  get inflight() {
    return this.queued.length;
  }
  buildAck(e, i, s = !1) {
    return { type: "ack", seq: e, decode_queue_size: i, displayed: s };
  }
  shouldSlowDown(e) {
    return e > this.cfg.slowDownQueue;
  }
  shouldRequestKeyframe(e) {
    return e > this.cfg.keyframeOnDropQueue;
  }
  reset() {
    this.queued = [];
  }
}
class O {
  constructor() {
    n(this, "armed", !0);
  }
  // true => still waiting for a keyframe
  needsKeyframe() {
    return this.armed;
  }
  /** Returns true if this chunk may be decoded; false => drop it. */
  accept(e) {
    if (this.armed) {
      if (!e) return !1;
      this.armed = !1;
    }
    return !0;
  }
  reset() {
    this.armed = !0;
  }
}
const B = "image/jpeg", E = "image/png", P = "webcodecs/h264-annexb", z = "avc1.42E01F";
async function A(t, e = 1280, i = 720) {
  const s = globalThis.VideoDecoder;
  if (!s || typeof s.isConfigSupported != "function") return !1;
  try {
    return !!(await s.isConfigSupported({ codec: t, codedWidth: e, codedHeight: i })).supported;
  } catch {
    return !1;
  }
}
async function F(t = {}) {
  const e = [B, E];
  return !t.imageOnly && await A(z, t.width, t.height) && e.push(P), { supported: e, devicePixelRatio: t.devicePixelRatio ?? 1 };
}
const K = new TextDecoder("utf-8");
new TextEncoder();
function T(t) {
  const e = t instanceof Uint8Array ? t : new Uint8Array(t);
  if (e.byteLength < 4)
    throw new Error("buffer too small to contain a header length prefix");
  const s = new DataView(e.buffer, e.byteOffset, e.byteLength).getUint32(0, !0);
  if (e.byteLength < 4 + s)
    throw new Error(\`buffer truncated: need \${4 + s} bytes, have \${e.byteLength}\`);
  const a = JSON.parse(K.decode(e.subarray(4, 4 + s))), h = e.subarray(4 + s);
  return { header: a, payload: h };
}
function I(t, e) {
  const i = { ...t };
  return e.rtt_ms !== void 0 && (i.serverRttMs = e.rtt_ms), e.fps_sent !== void 0 && (i.serverFpsSent = e.fps_sent), e.bitrate_bps !== void 0 && (i.serverBitrateBps = e.bitrate_bps), e.encode_ms !== void 0 && (i.serverEncodeMs = e.encode_ms), e.dropped !== void 0 && (i.serverDropped = e.dropped), e.target_bitrate !== void 0 && (i.targetBitrate = e.target_bitrate), e.target_fps !== void 0 && (i.targetFps = e.target_fps), i;
}
function N(t, e) {
  const i = { ...t };
  return e.bitrate !== void 0 && (i.targetBitrate = e.bitrate), e.fps !== void 0 && (i.targetFps = e.fps), i;
}
function U(t) {
  const e = t.frameW > 0 ? t.backingW / t.frameW : 1, i = t.frameH > 0 ? t.backingH / t.frameH : 1;
  switch (t.fit) {
    case "contain": {
      const s = Math.min(e, i);
      return { scaleX: s, scaleY: s };
    }
    case "cover": {
      const s = Math.max(e, i);
      return { scaleX: s, scaleY: s };
    }
    default:
      return { scaleX: e, scaleY: i };
  }
}
function v(t) {
  const { scaleX: e, scaleY: i } = U(t), s = t.frameW * e, a = t.frameH * i, h = (t.backingW - s) / 2, y = (t.backingH - a) / 2;
  return { dx: h, dy: y, dw: s, dh: a };
}
function L(t, e, i) {
  const { dx: s, dy: a, dw: h, dh: y } = v(t), b = h > 0 ? (e - s) / h * t.frameW : 0, w = y > 0 ? (i - a) / y * t.frameH : 0, W = b >= 0 && b < t.frameW && w >= 0 && w < t.frameH;
  return { x: b, y: w, inside: W };
}
async function M(t, e, i) {
  const s = new Blob([new Uint8Array(i)], { type: e.mime }), a = await createImageBitmap(s);
  try {
    t.draw(a, a.width, a.height);
  } finally {
    a.close();
  }
}
class V {
  constructor(e) {
    // Lazily created so the color space (from the server \`config\`, which arrives before
    // the first frame) can be chosen at getContext time — a 2D context's colorSpace is
    // fixed at creation and cannot be changed afterwards.
    n(this, "ctx", null);
    n(this, "colorSpace", "srgb");
    /** Fit mode when the frame AR differs from the canvas AR (default letterbox). */
    n(this, "fit", "contain");
    /** Letterbox fill for \`contain\` (any CSS color; default black). */
    n(this, "background", "#000");
    /** Current decoded frame size (device px), updated on each draw. */
    n(this, "frameW", 0);
    n(this, "frameH", 0);
    this.canvas = e;
  }
  context() {
    if (!this.ctx) {
      const e = this.canvas.getContext("2d", { colorSpace: this.colorSpace });
      if (!e) throw new Error("OffscreenCanvas 2D context unavailable");
      this.ctx = e;
    }
    return this.ctx;
  }
  /** Choose the canvas color space (\`"srgb"\` | \`"display-p3"\`). Must be called before the
   *  first draw/readPixels (context creation); ignored once the context exists. */
  setColorSpace(e) {
    e !== this.colorSpace && !this.ctx && (this.colorSpace = e);
  }
  resize(e, i) {
    e > 0 && i > 0 && (this.canvas.width = e, this.canvas.height = i);
  }
  /** The geometry state for the *current* frame size (used by the event path too). */
  viewportState() {
    return {
      frameW: this.frameW,
      frameH: this.frameH,
      backingW: this.canvas.width,
      backingH: this.canvas.height,
      fit: this.fit
    };
  }
  /** Draw a decoded frame of \`frameW x frameH\` device px, letterboxed/cropped per \`fit\`. */
  draw(e, i, s) {
    this.frameW = i, this.frameH = s;
    const a = this.context();
    a.fillStyle = this.background, a.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const { dx: h, dy: y, dw: b, dh: w } = v(this.viewportState());
    a.drawImage(e, h, y, b, w);
  }
  readPixels() {
    return this.context().getImageData(0, 0, this.canvas.width, this.canvas.height, {
      colorSpace: this.colorSpace
    });
  }
  toBlob(e = "image/png") {
    return this.canvas.convertToBlob({ type: e });
  }
}
class X {
  constructor(e, i, s, a, h) {
    n(this, "decoder", null);
    n(this, "codec", "");
    n(this, "codedWidth", 0);
    n(this, "codedHeight", 0);
    this.renderer = e, this.bp = i, this.gate = s, this.onRequestKeyframe = a, this.onDisplayed = h;
  }
  get decodeQueueSize() {
    var e;
    return ((e = this.decoder) == null ? void 0 : e.decodeQueueSize) ?? 0;
  }
  ensureDecoder(e) {
    this.decoder && this.codec === e.codec && this.codedWidth === e.width && this.codedHeight === e.height || (this.close(), this.codec = e.codec, this.codedWidth = e.width, this.codedHeight = e.height, this.decoder = new VideoDecoder({
      output: (i) => {
        try {
          this.renderer.draw(i, i.displayWidth || i.codedWidth, i.displayHeight || i.codedHeight);
        } finally {
          i.close();
        }
        const s = this.bp.onDisplayed();
        s !== void 0 && this.onDisplayed(s);
      },
      error: (i) => {
        this.gate.reset(), this.onRequestKeyframe(String(i));
      }
    }), this.decoder.configure({
      codec: e.codec,
      codedWidth: e.width,
      codedHeight: e.height
    }), this.gate.reset());
  }
  handleChunk(e, i) {
    if (this.ensureDecoder(e), !this.gate.accept(e.keyframe)) {
      this.onRequestKeyframe("awaiting keyframe");
      return;
    }
    const s = new EncodedVideoChunk({
      type: e.keyframe ? "key" : "delta",
      timestamp: e.timestamp_us,
      duration: e.duration_us,
      data: new Uint8Array(i)
    });
    this.bp.onQueued(e.seq), this.decoder.decode(s);
  }
  reset() {
    this.gate.reset(), this.bp.reset();
  }
  close() {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
      }
      this.decoder = null;
    }
  }
}
let c = null, r = null, o = null, x = null, f = 0, l = 0, m = 0, k = 0, S = 1, D = 1, p = {}, d = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
function u(t, e = []) {
  self.postMessage(t, e);
}
function g(t) {
  c && c.readyState === WebSocket.OPEN && c.send(JSON.stringify(t));
}
function _(t) {
  g({ type: "request_keyframe", reason: t });
}
function H(t, e) {
  d.framesDisplayed += 1, d.lastDisplayedSeq = t, d.decodeQueueSize = e, g({ type: "ack", seq: t, decode_queue_size: e, displayed: !0 }), u({ type: "stats", stats: { ...d } });
}
function J(t) {
  return (t && typeof t == "object" ? t.primaries : void 0) === "display-p3" ? "display-p3" : "srgb";
}
function Y(t) {
  if (t.type === "pointer_move" || t.type === "pointer_down" || t.type === "pointer_up" || t.type === "wheel") {
    const e = f > 0 ? m / f : 1, i = l > 0 ? k / l : 1, { x: s, y: a, inside: h } = L(r.viewportState(), t.x * e, t.y * i);
    return { ...t, x: s, y: a, inside: h, pixel_ratio: D };
  }
  return t;
}
function G(t) {
  t.type === "config" ? (typeof t.pixel_ratio == "number" && (D = t.pixel_ratio), t.color && (r == null || r.setColorSpace(J(t.color))), u({ type: "state", state: "negotiated" })) : t.type === "set_quality" ? (d = N(d, t), u({ type: "stats", stats: { ...d } })) : t.type === "stats" && (d = I(d, t), u({ type: "stats", stats: { ...d } }));
}
async function j(t) {
  const { header: e, payload: i } = T(t), s = e.pixel_ratio;
  if (typeof s == "number" && (D = s), e.type === "image_frame")
    d.transport = "image", await M(r, e, i), H(e.seq, 0);
  else if (e.type === "video_chunk") {
    d.transport = "webcodecs", o.handleChunk(e, i);
    const a = o.decodeQueueSize;
    x.shouldRequestKeyframe(a) && _("decode queue backlog");
  }
}
async function $(t) {
  c = new WebSocket(t), c.binaryType = "arraybuffer", u({ type: "state", state: "connecting" }), c.onopen = async () => {
    u({ type: "state", state: "open" }), o == null || o.reset();
    const e = await F({
      width: f || void 0,
      height: l || void 0,
      imageOnly: p.imageOnly
    });
    g({
      type: "hello",
      supported: e.supported,
      device_pixel_ratio: e.devicePixelRatio,
      token: p.token
      // undefined is dropped by JSON.stringify
    }), f > 0 && l > 0 && g({
      type: "set_viewport",
      width: f,
      height: l,
      pwidth: m,
      pheight: k,
      ratio: S
    });
  }, c.onmessage = (e) => {
    if (typeof e.data == "string") {
      G(JSON.parse(e.data));
      return;
    }
    j(e.data);
  }, c.onclose = () => u({ type: "state", state: "closed" }), c.onerror = () => u({ type: "error", error: "websocket error" });
}
function Z(t, e) {
  const i = r, s = {
    type: "capture-result",
    id: t,
    lastDisplayedSeq: d.lastDisplayedSeq,
    width: i.canvas.width,
    height: i.canvas.height
  };
  if (e === "blob")
    i.toBlob("image/png").then((a) => u({ ...s, blob: a }));
  else {
    const a = i.readPixels();
    u({ ...s, imageData: a }, [a.data.buffer]);
  }
}
self.onmessage = (t) => {
  const e = t.data;
  switch (e.type) {
    case "init": {
      p = e.options ?? {}, f = e.cssWidth, l = e.cssHeight, m = e.backingWidth, k = e.backingHeight, S = e.devicePixelRatio, r = new V(e.canvas), p.fit && (r.fit = p.fit), p.background && (r.background = p.background), r.resize(e.backingWidth, e.backingHeight), x = new Q({
        maxInflight: p.maxInflight,
        slowDownQueue: p.slowDownQueue,
        keyframeOnDropQueue: p.keyframeOnDropQueue
      }), o = new X(
        r,
        x,
        new O(),
        _,
        (i) => H(i, o.decodeQueueSize)
      ), u({ type: "ready" }), $(e.url);
      break;
    }
    case "event":
      g({ type: "event", event: Y(e.event) });
      break;
    case "set_fit":
      r && (e.fit && (r.fit = e.fit), e.background !== void 0 && (r.background = e.background));
      break;
    case "resize":
      f = e.cssWidth, l = e.cssHeight, m = e.backingWidth, k = e.backingHeight, S = e.pixelRatio, r == null || r.resize(e.backingWidth, e.backingHeight), o == null || o.reset(), g({
        type: "set_viewport",
        width: e.cssWidth,
        height: e.cssHeight,
        pwidth: e.backingWidth,
        pheight: e.backingHeight,
        ratio: e.pixelRatio
      }), _("viewport resized");
      break;
    case "capture":
      Z(e.id, e.format);
      break;
    case "dispose":
      o == null || o.close();
      try {
        c == null || c.close();
      } catch {
      }
      c = null;
      break;
  }
};
//# sourceMappingURL=entry-CdGweZ8e.js.map
`, W = typeof self < "u" && self.Blob && new Blob(["URL.revokeObjectURL(import.meta.url);", C], { type: "text/javascript;charset=utf-8" });
function I(t) {
  let e;
  try {
    if (e = W && (self.URL || self.webkitURL).createObjectURL(W), !e) throw "";
    const n = new Worker(e, {
      type: "module",
      name: t == null ? void 0 : t.name
    });
    return n.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(e);
    }), n;
  } catch {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(C),
      {
        type: "module",
        name: t == null ? void 0 : t.name
      }
    );
  }
}
function U() {
  return new I();
}
const $ = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
class Q {
  constructor(e, n) {
    h(this, "canvas");
    h(this, "worker");
    h(this, "options");
    h(this, "dpr");
    h(this, "backingWidth", 0);
    h(this, "backingHeight", 0);
    h(this, "resizeObserver");
    h(this, "captureWaiters", /* @__PURE__ */ new Map());
    h(this, "captureId", 0);
    h(this, "_lastCaptureSeq", -1);
    h(this, "disposed", !1);
    h(this, "_state", "connecting");
    h(this, "_stats", { ...$ });
    h(this, "onPointer", (e) => {
      if (e.type === "pointerdown") {
        this.canvas.focus();
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {
        }
      }
      const n = this.canvas.getBoundingClientRect();
      this.post({ type: "event", event: T(e, n) });
    });
    h(this, "onWheel", (e) => {
      const n = this.canvas.getBoundingClientRect();
      this.post({ type: "event", event: F(e, n) });
    });
    h(this, "onKey", (e) => {
      this.post({ type: "event", event: B(e) });
    });
    this.options = n, this.dpr = n.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1, this.canvas = this.resolveCanvas(e), this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0;
    const s = this.canvas.getBoundingClientRect(), i = s.width || this.canvas.clientWidth || 320, a = s.height || this.canvas.clientHeight || 240, c = _(i, a, this.dpr, n.maxBackingDimension);
    this.backingWidth = c.backingWidth, this.backingHeight = c.backingHeight, this.canvas.width = c.backingWidth, this.canvas.height = c.backingHeight;
    const o = this.canvas.transferControlToOffscreen();
    this.worker = (n.workerFactory ?? U)(), this.worker.onmessage = (l) => this.onWorkerMessage(l.data);
    const u = {
      type: "init",
      canvas: o,
      url: n.url,
      devicePixelRatio: this.dpr,
      backingWidth: c.backingWidth,
      backingHeight: c.backingHeight,
      cssWidth: i,
      cssHeight: a,
      options: {
        maxInflight: n.maxInflight,
        imageOnly: n.imageOnly,
        token: n.token,
        fit: n.fit,
        background: n.background
      }
    };
    this.worker.postMessage(u, [o]), this.attachListeners(), n.autoResize !== !1 && this.observeResize();
  }
  get state() {
    return this._state;
  }
  get stats() {
    return this._stats;
  }
  /** Seq of the frame measured by the most recent capture() (debug/test hook). */
  get lastCaptureSeq() {
    return this._lastCaptureSeq;
  }
  /** Change the fit mode (and optionally the letterbox background) on the live view. */
  setFit(e, n) {
    this.post({ type: "set_fit", fit: e, background: n });
  }
  capture(e = "imagedata") {
    const n = ++this.captureId;
    return new Promise((s) => {
      this.captureWaiters.set(n, s), this.post({ type: "capture", id: n, format: e });
    });
  }
  dispose() {
    var e;
    this.disposed || (this.disposed = !0, (e = this.resizeObserver) == null || e.disconnect(), this.detachListeners(), this.post({ type: "dispose" }), this.worker.terminate(), this.captureWaiters.clear());
  }
  // --- internals ----------------------------------------------------------
  resolveCanvas(e) {
    if (e instanceof HTMLCanvasElement) return e;
    const n = e.ownerDocument.createElement("canvas");
    return n.style.width = "100%", n.style.height = "100%", n.style.display = "block", e.appendChild(n), n;
  }
  post(e) {
    this.disposed || this.worker.postMessage(e);
  }
  attachListeners() {
    this.canvas.addEventListener("pointermove", this.onPointer), this.canvas.addEventListener("pointerdown", this.onPointer), this.canvas.addEventListener("pointerup", this.onPointer), this.canvas.addEventListener("wheel", this.onWheel, { passive: !0 }), this.canvas.addEventListener("keydown", this.onKey), this.canvas.addEventListener("keyup", this.onKey);
  }
  detachListeners() {
    this.canvas.removeEventListener("pointermove", this.onPointer), this.canvas.removeEventListener("pointerdown", this.onPointer), this.canvas.removeEventListener("pointerup", this.onPointer), this.canvas.removeEventListener("wheel", this.onWheel), this.canvas.removeEventListener("keydown", this.onKey), this.canvas.removeEventListener("keyup", this.onKey);
  }
  observeResize() {
    this.resizeObserver = new ResizeObserver(() => {
      const e = this.canvas.getBoundingClientRect();
      if (e.width === 0 || e.height === 0) return;
      this.dpr = this.options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
      const n = _(
        e.width,
        e.height,
        this.dpr,
        this.options.maxBackingDimension
      );
      n.backingWidth === this.backingWidth && n.backingHeight === this.backingHeight || (this.backingWidth = n.backingWidth, this.backingHeight = n.backingHeight, this.post({
        type: "resize",
        backingWidth: n.backingWidth,
        backingHeight: n.backingHeight,
        cssWidth: e.width,
        cssHeight: e.height,
        pixelRatio: n.pixelRatio
      }));
    }), this.resizeObserver.observe(this.canvas);
  }
  onWorkerMessage(e) {
    var n, s, i, a, c, o;
    switch (e.type) {
      case "state":
        this._state = e.state, (s = (n = this.options).onState) == null || s.call(n, e.state);
        break;
      case "stats":
        this._stats = e.stats, (a = (i = this.options).onStats) == null || a.call(i, e.stats);
        break;
      case "capture-result": {
        this._lastCaptureSeq = e.lastDisplayedSeq;
        const u = this.captureWaiters.get(e.id);
        u && (this.captureWaiters.delete(e.id), u(e.imageData ?? e.blob));
        break;
      }
      case "error":
        this._state = "error", (o = (c = this.options).onError) == null || o.call(c, new Error(e.error));
        break;
    }
  }
}
new TextDecoder("utf-8");
new TextEncoder();
const R = (t) => t === void 0 ? "—" : `${(t / 1e6).toFixed(1)} Mbps`, H = (t) => t === void 0 ? "—" : `${t.toFixed(0)} ms`, E = (t) => t === void 0 ? "—" : t.toFixed(1);
function M(t) {
  return t === "negotiated" ? "live" : t;
}
function j(t, e) {
  return [
    ["state", M(t)],
    ["transport", e.transport],
    ["displayed", `${e.framesDisplayed} (dropped ${e.framesDropped})`],
    ["decode queue", String(e.decodeQueueSize)],
    ["rtt", H(e.serverRttMs)],
    ["server fps", E(e.serverFpsSent)],
    ["server bitrate", R(e.serverBitrateBps)],
    ["encode", H(e.serverEncodeMs)],
    ["target bitrate", R(e.targetBitrate)],
    ["target fps", E(e.targetFps)]
  ];
}
function K(t) {
  const n = [t.transport === "webcodecs" ? "H.264" : t.transport === "image" ? "IMG" : "—"];
  return t.serverFpsSent !== void 0 && n.push(`${t.serverFpsSent.toFixed(0)} fps`), t.serverRttMs !== void 0 && n.push(`${t.serverRttMs.toFixed(0)} ms`), n.join(" · ");
}
function b(t, e, n) {
  const s = document.createElement("button");
  return s.type = "button", s.className = "rfb-button", s.title = e, s.textContent = t, s.addEventListener("click", n), s;
}
function N(t, e, n) {
  const s = document.createElement("div");
  s.className = "rfb-status";
  const i = document.createElement("div");
  i.className = "rfb-badge", i.style.display = "none";
  const a = document.createElement("pre");
  a.className = "rfb-hud", a.style.display = "none";
  const c = document.createElement("span"), o = document.createElement("div");
  o.className = "rfb-banner", o.setAttribute("role", "alert"), o.style.display = "none", o.append(c, b("↻", "Reconnect", () => n.reconnect()));
  const u = document.createElement("div");
  u.className = "rfb-loading", u.appendChild(Object.assign(document.createElement("div"), { className: "rfb-spinner" }));
  const l = b("📊", "Toggle stats", () => k()), f = document.createElement("div");
  f.className = "rfb-toolbar", f.append(
    l,
    b("⇄", "Toggle transport", () => n.toggleTransport()),
    b("📷", "Screenshot", z),
    b("⛶", "Fullscreen", () => n.fullscreen())
  ), t.append(s, i, f, a, o, u);
  let p = !1, r = "connecting", g = null;
  function z() {
    n.capture("blob").then((d) => {
      const v = URL.createObjectURL(d), y = document.createElement("a");
      y.href = v, y.download = "framebuffer.png", y.click(), setTimeout(() => URL.revokeObjectURL(v), 1e3);
    });
  }
  function k() {
    p = !p, m();
  }
  function m() {
    const d = p && e.get("show_stats") !== !1;
    a.style.display = d ? "" : "none", l.dataset.active = String(p), d && g && (a.textContent = j(r, g).map(([v, y]) => `${v.padEnd(15)}${y}`).join(`
`));
  }
  function x() {
    f.style.display = e.get("show_toolbar") !== !1 ? "" : "none", e.get("show_stats") === !1 && (p = !1), m();
  }
  return x(), {
    setState(d) {
      r = d, s.textContent = M(d), m();
    },
    setStats(d) {
      g = d, d.transport !== "none" && (i.style.display = "", i.textContent = K(d)), d.framesDisplayed > 0 && (u.style.display = "none"), m();
    },
    setError(d) {
      d ? (c.textContent = d.message, o.style.display = "") : o.style.display = "none";
    },
    toggleHud: k,
    refresh: x,
    destroy() {
      for (const d of [s, i, f, a, o, u]) d.remove();
    }
  };
}
function A(t) {
  const e = t.get("url");
  if (e) return String(e);
  const n = t.get("stream") || "default", s = location.protocol === "https:" ? "wss" : "ws", i = t.get("base_path");
  if (i) {
    const c = String(i).replace(/\/+$/, "");
    return `${s}://${location.host}${c}/${n}`;
  }
  let a = t.get("host");
  return (!a || a === "auto" || a === "0.0.0.0" || a === "::") && (a = location.hostname || "127.0.0.1"), `${s}://${a}:${t.get("port")}/${n}`;
}
const Y = {
  render({ model: t, el: e }) {
    e.classList.add("rfb-root"), e.dataset.state = "connecting";
    const n = t.get("height");
    n && (e.style.height = typeof n == "number" ? `${n}px` : String(n));
    const s = document.createElement("div");
    s.className = "rfb-viewport", e.appendChild(s);
    let i = null, a = 0;
    const o = N(e, t, {
      capture: (r) => i ? i.capture(r) : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
      toggleTransport: () => {
        t.set("image_only", !t.get("image_only")), t.save_changes();
      },
      fullscreen: () => {
        var r;
        return void ((r = e.requestFullscreen) == null ? void 0 : r.call(e));
      },
      reconnect: () => l()
    });
    function u(r) {
      const g = performance.now();
      g - a < 1e3 || (a = g, t.set("stats", {
        transport: r.transport,
        framesDisplayed: r.framesDisplayed,
        framesDropped: r.framesDropped,
        decodeQueueSize: r.decodeQueueSize,
        serverFpsSent: r.serverFpsSent ?? null,
        serverRttMs: r.serverRttMs ?? null
      }), t.save_changes());
    }
    function l() {
      i == null || i.dispose(), e.dataset.state = "connecting", i = new Q(s, {
        url: A(t),
        token: t.get("token") || void 0,
        imageOnly: !!t.get("image_only"),
        fit: t.get("fit") || void 0,
        background: t.get("background") || void 0,
        onState: (r) => {
          e.dataset.state = r, t.set("state", r), t.save_changes(), o.setState(r);
        },
        onStats: (r) => {
          o.setStats(r), u(r);
        },
        onError: (r) => {
          t.set("last_error", r.message), t.save_changes(), o.setError(r);
        }
      }), o.setError(null);
    }
    const f = () => l(), p = () => o.refresh();
    for (const r of ["url", "host", "base_path", "port", "stream", "token", "image_only", "fit", "background"])
      t.on(`change:${r}`, f);
    return t.on("change:show_toolbar", p), t.on("change:show_stats", p), l(), () => {
      t.off(null, null), i == null || i.dispose(), i = null, o.destroy(), s.remove(), e.classList.remove("rfb-root"), delete e.dataset.state;
    };
  }
};
export {
  Y as default
};
//# sourceMappingURL=widget.js.map
