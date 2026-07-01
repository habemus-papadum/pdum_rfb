var M = Object.defineProperty;
var O = (t, e, n) => e in t ? M(t, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : t[e] = n;
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
function L(t) {
  const e = [];
  return t & 1 && e.push(1), t & 2 && e.push(2), t & 4 && e.push(3), t & 8 && e.push(4), t & 16 && e.push(5), e;
}
function H(t, e, n) {
  return { x: t - n.left, y: e - n.top };
}
function S(t, e, n) {
  return e === 1 ? t * 16 : e === 2 ? t * n : t;
}
function T(t, e) {
  const { x: n, y: s } = H(t.clientX, t.clientY, e);
  return {
    type: t.type === "pointerdown" ? "pointer_down" : t.type === "pointerup" ? "pointer_up" : "pointer_move",
    x: n,
    y: s,
    button: P(t.button),
    buttons: L(t.buttons),
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function B(t, e) {
  const { x: n, y: s } = H(t.clientX, t.clientY, e);
  return {
    type: "wheel",
    x: n,
    y: s,
    dx: S(t.deltaX, t.deltaMode, e.width),
    dy: S(t.deltaY, t.deltaMode, e.height),
    buttons: L(t.buttons),
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function F(t) {
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
const C = `var D = Object.defineProperty;
var _ = (t, e, i) => e in t ? D(t, e, { enumerable: !0, configurable: !0, writable: !0, value: i }) : t[e] = i;
var d = (t, e, i) => _(t, typeof e != "symbol" ? e + "" : e, i);
const x = {
  maxInflight: 3,
  slowDownQueue: 3,
  keyframeOnDropQueue: 6
};
class S {
  constructor(e = {}) {
    d(this, "cfg");
    d(this, "queued", []);
    this.cfg = { ...x, ...e };
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
class q {
  constructor() {
    d(this, "armed", !0);
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
const C = "image/jpeg", H = "image/png", W = "webcodecs/h264-annexb", Q = "avc1.42E01F";
async function O(t, e = 1280, i = 720) {
  const s = globalThis.VideoDecoder;
  if (!s || typeof s.isConfigSupported != "function") return !1;
  try {
    return !!(await s.isConfigSupported({ codec: t, codedWidth: e, codedHeight: i })).supported;
  } catch {
    return !1;
  }
}
async function B(t = {}) {
  const e = [C, H];
  return !t.imageOnly && await O(Q, t.width, t.height) && e.push(W), { supported: e, devicePixelRatio: t.devicePixelRatio ?? 1 };
}
const R = new TextDecoder("utf-8");
new TextEncoder();
function E(t) {
  const e = t instanceof Uint8Array ? t : new Uint8Array(t);
  if (e.byteLength < 4)
    throw new Error("buffer too small to contain a header length prefix");
  const s = new DataView(e.buffer, e.byteOffset, e.byteLength).getUint32(0, !0);
  if (e.byteLength < 4 + s)
    throw new Error(\`buffer truncated: need \${4 + s} bytes, have \${e.byteLength}\`);
  const o = JSON.parse(R.decode(e.subarray(4, 4 + s))), y = e.subarray(4 + s);
  return { header: o, payload: y };
}
function P(t, e) {
  const i = { ...t };
  return e.rtt_ms !== void 0 && (i.serverRttMs = e.rtt_ms), e.fps_sent !== void 0 && (i.serverFpsSent = e.fps_sent), e.bitrate_bps !== void 0 && (i.serverBitrateBps = e.bitrate_bps), e.encode_ms !== void 0 && (i.serverEncodeMs = e.encode_ms), e.dropped !== void 0 && (i.serverDropped = e.dropped), e.target_bitrate !== void 0 && (i.targetBitrate = e.target_bitrate), e.target_fps !== void 0 && (i.targetFps = e.target_fps), i;
}
function z(t, e) {
  const i = { ...t };
  return e.bitrate !== void 0 && (i.targetBitrate = e.bitrate), e.fps !== void 0 && (i.targetFps = e.fps), i;
}
async function A(t, e, i) {
  const s = new Blob([new Uint8Array(i)], { type: e.mime }), o = await createImageBitmap(s);
  try {
    t.draw(o);
  } finally {
    o.close();
  }
}
class K {
  constructor(e) {
    d(this, "ctx");
    this.canvas = e;
    const i = e.getContext("2d");
    if (!i) throw new Error("OffscreenCanvas 2D context unavailable");
    this.ctx = i;
  }
  resize(e, i) {
    e > 0 && i > 0 && (this.canvas.width = e, this.canvas.height = i);
  }
  draw(e) {
    this.ctx.drawImage(e, 0, 0, this.canvas.width, this.canvas.height);
  }
  readPixels() {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }
  toBlob(e = "image/png") {
    return this.canvas.convertToBlob({ type: e });
  }
}
class F {
  constructor(e, i, s, o, y) {
    d(this, "decoder", null);
    d(this, "codec", "");
    d(this, "codedWidth", 0);
    d(this, "codedHeight", 0);
    this.renderer = e, this.bp = i, this.gate = s, this.onRequestKeyframe = o, this.onDisplayed = y;
  }
  get decodeQueueSize() {
    var e;
    return ((e = this.decoder) == null ? void 0 : e.decodeQueueSize) ?? 0;
  }
  ensureDecoder(e) {
    this.decoder && this.codec === e.codec && this.codedWidth === e.width && this.codedHeight === e.height || (this.close(), this.codec = e.codec, this.codedWidth = e.width, this.codedHeight = e.height, this.decoder = new VideoDecoder({
      output: (i) => {
        try {
          this.renderer.draw(i);
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
let n = null, h = null, a = null, g = null, l = 0, f = 0, b = 0, w = 0, v = 1, u = {}, r = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
function c(t, e = []) {
  self.postMessage(t, e);
}
function p(t) {
  n && n.readyState === WebSocket.OPEN && n.send(JSON.stringify(t));
}
function m(t) {
  p({ type: "request_keyframe", reason: t });
}
function k(t, e) {
  r.framesDisplayed += 1, r.lastDisplayedSeq = t, r.decodeQueueSize = e, p({ type: "ack", seq: t, decode_queue_size: e, displayed: !0 }), c({ type: "stats", stats: { ...r } });
}
function I(t) {
  t.type === "config" ? c({ type: "state", state: "negotiated" }) : t.type === "set_quality" ? (r = z(r, t), c({ type: "stats", stats: { ...r } })) : t.type === "stats" && (r = P(r, t), c({ type: "stats", stats: { ...r } }));
}
async function N(t) {
  const { header: e, payload: i } = E(t);
  if (e.type === "image_frame")
    r.transport = "image", await A(h, e, i), k(e.seq, 0);
  else if (e.type === "video_chunk") {
    r.transport = "webcodecs", a.handleChunk(e, i);
    const s = a.decodeQueueSize;
    g.shouldRequestKeyframe(s) && m("decode queue backlog");
  }
}
async function T(t) {
  n = new WebSocket(t), n.binaryType = "arraybuffer", c({ type: "state", state: "connecting" }), n.onopen = async () => {
    c({ type: "state", state: "open" }), a == null || a.reset();
    const e = await B({
      width: l || void 0,
      height: f || void 0,
      imageOnly: u.imageOnly
    });
    p({
      type: "hello",
      supported: e.supported,
      device_pixel_ratio: e.devicePixelRatio,
      token: u.token
      // undefined is dropped by JSON.stringify
    }), l > 0 && f > 0 && p({
      type: "set_viewport",
      width: l,
      height: f,
      pwidth: b,
      pheight: w,
      ratio: v
    });
  }, n.onmessage = (e) => {
    if (typeof e.data == "string") {
      I(JSON.parse(e.data));
      return;
    }
    N(e.data);
  }, n.onclose = () => c({ type: "state", state: "closed" }), n.onerror = () => c({ type: "error", error: "websocket error" });
}
function U(t, e) {
  const i = h, s = {
    type: "capture-result",
    id: t,
    lastDisplayedSeq: r.lastDisplayedSeq,
    width: i.canvas.width,
    height: i.canvas.height
  };
  if (e === "blob")
    i.toBlob("image/png").then((o) => c({ ...s, blob: o }));
  else {
    const o = i.readPixels();
    c({ ...s, imageData: o }, [o.data.buffer]);
  }
}
self.onmessage = (t) => {
  const e = t.data;
  switch (e.type) {
    case "init": {
      u = e.options ?? {}, l = e.cssWidth, f = e.cssHeight, b = e.backingWidth, w = e.backingHeight, v = e.devicePixelRatio, h = new K(e.canvas), h.resize(e.backingWidth, e.backingHeight), g = new S({
        maxInflight: u.maxInflight,
        slowDownQueue: u.slowDownQueue,
        keyframeOnDropQueue: u.keyframeOnDropQueue
      }), a = new F(
        h,
        g,
        new q(),
        m,
        (i) => k(i, a.decodeQueueSize)
      ), c({ type: "ready" }), T(e.url);
      break;
    }
    case "event":
      p({ type: "event", event: e.event });
      break;
    case "resize":
      l = e.cssWidth, f = e.cssHeight, b = e.backingWidth, w = e.backingHeight, v = e.pixelRatio, h == null || h.resize(e.backingWidth, e.backingHeight), a == null || a.reset(), p({
        type: "set_viewport",
        width: e.cssWidth,
        height: e.cssHeight,
        pwidth: e.backingWidth,
        pheight: e.backingHeight,
        ratio: e.pixelRatio
      }), m("viewport resized");
      break;
    case "capture":
      U(e.id, e.format);
      break;
    case "dispose":
      a == null || a.close();
      try {
        n == null || n.close();
      } catch {
      }
      n = null;
      break;
  }
};
//# sourceMappingURL=entry-yEsQcsln.js.map
`, E = typeof self < "u" && self.Blob && new Blob(["URL.revokeObjectURL(import.meta.url);", C], { type: "text/javascript;charset=utf-8" });
function I(t) {
  let e;
  try {
    if (e = E && (self.URL || self.webkitURL).createObjectURL(E), !e) throw "";
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
function Q() {
  return new I();
}
const U = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
class $ {
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
    h(this, "_stats", { ...U });
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
      this.post({ type: "event", event: B(e, n) });
    });
    h(this, "onKey", (e) => {
      this.post({ type: "event", event: F(e) });
    });
    this.options = n, this.dpr = n.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1, this.canvas = this.resolveCanvas(e), this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0;
    const s = this.canvas.getBoundingClientRect(), i = s.width || this.canvas.clientWidth || 320, a = s.height || this.canvas.clientHeight || 240, c = _(i, a, this.dpr, n.maxBackingDimension);
    this.backingWidth = c.backingWidth, this.backingHeight = c.backingHeight, this.canvas.width = c.backingWidth, this.canvas.height = c.backingHeight;
    const o = this.canvas.transferControlToOffscreen();
    this.worker = (n.workerFactory ?? Q)(), this.worker.onmessage = (l) => this.onWorkerMessage(l.data);
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
        token: n.token
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
const R = (t) => t === void 0 ? "—" : `${(t / 1e6).toFixed(1)} Mbps`, W = (t) => t === void 0 ? "—" : `${t.toFixed(0)} ms`, D = (t) => t === void 0 ? "—" : t.toFixed(1);
function q(t) {
  return t === "negotiated" ? "live" : t;
}
function K(t, e) {
  return [
    ["state", q(t)],
    ["transport", e.transport],
    ["displayed", `${e.framesDisplayed} (dropped ${e.framesDropped})`],
    ["decode queue", String(e.decodeQueueSize)],
    ["rtt", W(e.serverRttMs)],
    ["server fps", D(e.serverFpsSent)],
    ["server bitrate", R(e.serverBitrateBps)],
    ["encode", W(e.serverEncodeMs)],
    ["target bitrate", R(e.targetBitrate)],
    ["target fps", D(e.targetFps)]
  ];
}
function N(t) {
  const n = [t.transport === "webcodecs" ? "H.264" : t.transport === "image" ? "IMG" : "—"];
  return t.serverFpsSent !== void 0 && n.push(`${t.serverFpsSent.toFixed(0)} fps`), t.serverRttMs !== void 0 && n.push(`${t.serverRttMs.toFixed(0)} ms`), n.join(" · ");
}
function b(t, e, n) {
  const s = document.createElement("button");
  return s.type = "button", s.className = "rfb-button", s.title = e, s.textContent = t, s.addEventListener("click", n), s;
}
function j(t, e, n) {
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
    a.style.display = d ? "" : "none", l.dataset.active = String(p), d && g && (a.textContent = K(r, g).map(([v, y]) => `${v.padEnd(15)}${y}`).join(`
`));
  }
  function x() {
    f.style.display = e.get("show_toolbar") !== !1 ? "" : "none", e.get("show_stats") === !1 && (p = !1), m();
  }
  return x(), {
    setState(d) {
      r = d, s.textContent = q(d), m();
    },
    setStats(d) {
      g = d, d.transport !== "none" && (i.style.display = "", i.textContent = N(d)), d.framesDisplayed > 0 && (u.style.display = "none"), m();
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
const X = {
  render({ model: t, el: e }) {
    e.classList.add("rfb-root"), e.dataset.state = "connecting";
    const n = t.get("height");
    n && (e.style.height = typeof n == "number" ? `${n}px` : String(n));
    const s = document.createElement("div");
    s.className = "rfb-viewport", e.appendChild(s);
    let i = null, a = 0;
    const o = j(e, t, {
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
      i == null || i.dispose(), e.dataset.state = "connecting", i = new $(s, {
        url: A(t),
        token: t.get("token") || void 0,
        imageOnly: !!t.get("image_only"),
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
    for (const r of ["url", "host", "base_path", "port", "stream", "token", "image_only"])
      t.on(`change:${r}`, f);
    return t.on("change:show_toolbar", p), t.on("change:show_stats", p), l(), () => {
      t.off(null, null), i == null || i.dispose(), i = null, o.destroy(), s.remove(), e.classList.remove("rfb-root"), delete e.dataset.state;
    };
  }
};
export {
  X as default
};
//# sourceMappingURL=widget.js.map
