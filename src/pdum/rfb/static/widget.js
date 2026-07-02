var P = Object.defineProperty;
var z = (t, e, n) => e in t ? P(t, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : t[e] = n;
var d = (t, e, n) => z(t, typeof e != "symbol" ? e + "" : e, n);
function w(t) {
  const e = [];
  return t.shiftKey && e.push("Shift"), t.ctrlKey && e.push("Control"), t.altKey && e.push("Alt"), t.metaKey && e.push("Meta"), e;
}
function O(t) {
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
function E(t) {
  const e = [];
  return t & 1 && e.push(1), t & 2 && e.push(2), t & 4 && e.push(3), t & 8 && e.push(4), t & 16 && e.push(5), e;
}
function q(t, e, n) {
  return { x: t - n.left, y: e - n.top };
}
function S(t, e, n) {
  return e === 1 ? t * 16 : e === 2 ? t * n : t;
}
function $(t, e) {
  const { x: n, y: s } = q(t.clientX, t.clientY, e);
  return {
    type: t.type === "pointerdown" ? "pointer_down" : t.type === "pointerup" ? "pointer_up" : "pointer_move",
    x: n,
    y: s,
    button: O(t.button),
    buttons: E(t.buttons),
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function F(t, e) {
  const { x: n, y: s } = q(t.clientX, t.clientY, e);
  return {
    type: "wheel",
    x: n,
    y: s,
    dx: S(t.deltaX, t.deltaMode, e.width),
    dy: S(t.deltaY, t.deltaMode, e.height),
    buttons: E(t.buttons),
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function T(t) {
  return {
    type: t.type === "keydown" ? "key_down" : "key_up",
    key: t.key,
    code: t.code,
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function _(t, e, n, s) {
  let i = Math.max(1, Math.round(t * n)), r = Math.max(1, Math.round(e * n)), c = n;
  if (s && Math.max(i, r) > s) {
    const o = s / Math.max(i, r);
    i = Math.max(1, Math.round(i * o)), r = Math.max(1, Math.round(r * o)), c = t > 0 ? i / t : n;
  }
  return { backingWidth: i, backingHeight: r, pixelRatio: c };
}
const I = () => {
};
function Q(t, e) {
  const n = `[rfb:${e}]`;
  return {
    enabled: t,
    log: t ? (s, ...i) => console.debug(`${n} ${s}`, ...i) : I,
    error: (s, ...i) => console.error(`${n} ${s}`, ...i)
  };
}
const L = `var B = Object.defineProperty;
var T = (t, e, i) => e in t ? B(t, e, { enumerable: !0, configurable: !0, writable: !0, value: i }) : t[e] = i;
var a = (t, e, i) => T(t, typeof e != "symbol" ? e + "" : e, i);
const z = {
  maxInflight: 3,
  slowDownQueue: 3,
  keyframeOnDropQueue: 6
};
class F {
  constructor(e = {}) {
    a(this, "cfg");
    a(this, "queued", []);
    this.cfg = { ...z, ...e };
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
class N {
  constructor() {
    a(this, "armed", !0);
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
const I = "image/jpeg", L = "image/png", K = "webcodecs/h264-annexb", $ = "avc1.42E01F";
async function U(t, e = 1280, i = 720) {
  const s = globalThis.VideoDecoder;
  if (!s || typeof s.isConfigSupported != "function") return !1;
  try {
    return !!(await s.isConfigSupported({ codec: t, codedWidth: e, codedHeight: i })).supported;
  } catch {
    return !1;
  }
}
async function V(t = {}) {
  const e = [I, L];
  return !t.imageOnly && await U($, t.width, t.height) && e.push(K), { supported: e, devicePixelRatio: t.devicePixelRatio ?? 1 };
}
const X = () => {
};
function P(t, e) {
  const i = \`[rfb:\${e}]\`;
  return {
    enabled: t,
    log: t ? (s, ...o) => console.debug(\`\${i} \${s}\`, ...o) : X,
    error: (s, ...o) => console.error(\`\${i} \${s}\`, ...o)
  };
}
const J = new TextDecoder("utf-8");
new TextEncoder();
function Y(t) {
  const e = t instanceof Uint8Array ? t : new Uint8Array(t);
  if (e.byteLength < 4)
    throw new Error("buffer too small to contain a header length prefix");
  const s = new DataView(e.buffer, e.byteOffset, e.byteLength).getUint32(0, !0);
  if (e.byteLength < 4 + s)
    throw new Error(\`buffer truncated: need \${4 + s} bytes, have \${e.byteLength}\`);
  const o = JSON.parse(J.decode(e.subarray(4, 4 + s))), c = e.subarray(4 + s);
  return { header: o, payload: c };
}
const j = 500, G = 1e4;
function Z(t, e = Math.random) {
  const i = Math.min(G, j * 2 ** Math.max(0, t));
  return Math.round(i * (0.5 + 0.5 * e()));
}
function ee(t) {
  return t === 4401 || t === 4404;
}
function te(t, e) {
  const i = { ...t };
  return e.rtt_ms !== void 0 && (i.serverRttMs = e.rtt_ms), e.fps_sent !== void 0 && (i.serverFpsSent = e.fps_sent), e.bitrate_bps !== void 0 && (i.serverBitrateBps = e.bitrate_bps), e.encode_ms !== void 0 && (i.serverEncodeMs = e.encode_ms), e.dropped !== void 0 && (i.serverDropped = e.dropped), e.target_bitrate !== void 0 && (i.targetBitrate = e.target_bitrate), e.target_fps !== void 0 && (i.targetFps = e.target_fps), i;
}
function ie(t, e) {
  const i = { ...t };
  return e.bitrate !== void 0 && (i.targetBitrate = e.bitrate), e.fps !== void 0 && (i.targetFps = e.fps), i;
}
function se(t) {
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
function A(t) {
  const { scaleX: e, scaleY: i } = se(t), s = t.frameW * e, o = t.frameH * i, c = (t.backingW - s) / 2, g = (t.backingH - o) / 2;
  return { dx: c, dy: g, dw: s, dh: o };
}
function oe(t, e, i) {
  const { dx: s, dy: o, dw: c, dh: g } = A(t), f = c > 0 ? (e - s) / c * t.frameW : 0, y = g > 0 ? (i - o) / g * t.frameH : 0, O = f >= 0 && f < t.frameW && y >= 0 && y < t.frameH;
  return { x: f, y, inside: O };
}
async function re(t, e, i) {
  const s = new Blob([new Uint8Array(i)], { type: e.mime }), o = await createImageBitmap(s);
  try {
    t.draw(o, o.width, o.height);
  } finally {
    o.close();
  }
}
class ae {
  constructor(e) {
    // Lazily created so the color space (from the server \`config\`, which arrives before
    // the first frame) can be chosen at getContext time — a 2D context's colorSpace is
    // fixed at creation and cannot be changed afterwards.
    a(this, "ctx", null);
    a(this, "colorSpace", "srgb");
    /** Fit mode when the frame AR differs from the canvas AR (default letterbox). */
    a(this, "fit", "contain");
    /** Letterbox fill for \`contain\` (any CSS color; default black). */
    a(this, "background", "#000");
    /** Current decoded frame size (device px), updated on each draw. */
    a(this, "frameW", 0);
    a(this, "frameH", 0);
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
    const o = this.context();
    o.fillStyle = this.background, o.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const { dx: c, dy: g, dw: f, dh: y } = A(this.viewportState());
    o.drawImage(e, c, g, f, y);
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
class ne {
  /**
   * @param stallMs  how long a backlog may sit with zero new output before it's a stall.
   * @param now      monotonic clock in ms (inject \`performance.now\`; overridable for tests).
   * @param onStall  fired once per stall edge (check() also returns true on that edge).
   */
  constructor(e, i, s) {
    a(this, "queued", 0);
    a(this, "displayed", 0);
    /** Wall-clock when the current outstanding backlog began (\`null\` = nothing pending).
     *  A nullable — not a 0 sentinel — so a legitimate timestamp of 0 isn't read as "idle". */
    a(this, "oldestPendingAt", null);
    a(this, "stalled", !1);
    this.stallMs = e, this.now = i, this.onStall = s;
  }
  /** A chunk was handed to the decoder. Starts the stall timer if we were caught up. */
  onQueued() {
    const e = this.queued === this.displayed;
    this.queued += 1, e && (this.oldestPendingAt = this.now());
  }
  /** The decoder emitted a frame — progress. Clears the stall, restarts the timer if a
   *  backlog remains (so slow-but-progressing decode never trips). */
  onDisplayed() {
    this.displayed += 1, this.stalled = !1, this.oldestPendingAt = this.queued === this.displayed ? null : this.now();
  }
  /** Forget the outstanding backlog (decoder rebuilt / stream reset). */
  reset() {
    this.queued = 0, this.displayed = 0, this.oldestPendingAt = null, this.stalled = !1;
  }
  /** True exactly once when a backlog has produced no output for \`stallMs\`. */
  check() {
    return this.oldestPendingAt !== null && !this.stalled && this.now() - this.oldestPendingAt > this.stallMs ? (this.stalled = !0, this.onStall(), !0) : !1;
  }
  get pending() {
    return this.queued - this.displayed;
  }
}
const ce = { enabled: !1, log: () => {
}, error: () => {
} }, de = () => typeof performance < "u" ? performance.now() : Date.now();
class le {
  constructor(e, i, s, o, c, g = ce, f = {}) {
    a(this, "decoder", null);
    a(this, "codec", "");
    a(this, "codedWidth", 0);
    a(this, "codedHeight", 0);
    a(this, "lastHeader", null);
    a(this, "watchdog");
    a(this, "hooks");
    this.renderer = e, this.bp = i, this.gate = s, this.onRequestKeyframe = o, this.onDisplayed = c, this.log = g;
    const y = f.now ?? de;
    this.hooks = {
      onDecoderReset: f.onDecoderReset ?? (() => {
      }),
      onRecovered: f.onRecovered ?? (() => {
      }),
      onFatal: f.onFatal ?? (() => {
      }),
      now: y
    }, this.watchdog = new ne(f.stallMs ?? 1200, y, () => this.recover());
  }
  get decodeQueueSize() {
    var e;
    return ((e = this.decoder) == null ? void 0 : e.decodeQueueSize) ?? 0;
  }
  ensureDecoder(e) {
    if (this.decoder && this.codec === e.codec && this.codedWidth === e.width && this.codedHeight === e.height)
      return;
    this.close(), this.codec = e.codec, this.codedWidth = e.width, this.codedHeight = e.height;
    const i = new VideoDecoder({
      output: (s) => {
        try {
          this.renderer.draw(s, s.displayWidth || s.codedWidth, s.displayHeight || s.codedHeight);
        } finally {
          s.close();
        }
        this.watchdog.onDisplayed();
        const o = this.bp.onDisplayed();
        o !== void 0 && this.onDisplayed(o);
      },
      error: (s) => {
        this.log.error("decode", "VideoDecoder error", s), this.gate.reset(), this.onRequestKeyframe(\`decode error: \${s}\`);
      }
    });
    this.log.log("decode", "configure", { codec: e.codec, w: e.width, h: e.height });
    try {
      i.configure({
        codec: e.codec,
        codedWidth: e.width,
        codedHeight: e.height,
        optimizeForLatency: !0
      });
    } catch (s) {
      try {
        i.close();
      } catch {
      }
      this.log.error("decode", "configure() failed (fatal)", s), this.hooks.onFatal(\`video decoder configure failed: \${s}\`);
      return;
    }
    this.decoder = i, this.gate.reset();
  }
  handleChunk(e, i) {
    if (this.lastHeader = e, this.ensureDecoder(e), !this.decoder) return;
    if (!this.gate.accept(e.keyframe)) {
      this.onRequestKeyframe("awaiting keyframe");
      return;
    }
    const s = new EncodedVideoChunk({
      type: e.keyframe ? "key" : "delta",
      timestamp: e.timestamp_us,
      duration: e.duration_us,
      data: new Uint8Array(i)
    });
    this.bp.onQueued(e.seq), this.watchdog.onQueued(), this.decoder.decode(s);
  }
  /** Called periodically by the worker's watchdog tick; triggers recovery on a stall. */
  checkStall() {
    this.watchdog.check();
  }
  /** Rebuild the decoder from scratch, re-arm, request a keyframe, and tell the server to
   *  release its inflight — the only thing that un-sticks a decoder that stopped emitting. */
  recover() {
    const e = this.lastHeader;
    this.log.error("stall", "decode stall detected — rebuilding decoder, requesting keyframe + server reset"), this.close(), this.watchdog.reset(), this.gate.reset(), this.bp.reset(), e && this.ensureDecoder(e), this.onRequestKeyframe("decoder stall recovery"), this.hooks.onDecoderReset(), this.hooks.onRecovered();
  }
  reset() {
    this.gate.reset(), this.bp.reset(), this.watchdog.reset();
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
let u = null, n = null, d = null, H = null, b = 0, m = 0, _ = 0, D = 0, W = 1, C = 1, p = {}, l = P(!1, "worker"), v = null, S = null, q = !1, k = null, x = 0, r = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
function h(t, e = []) {
  self.postMessage(t, e);
}
function w(t) {
  u && u.readyState === WebSocket.OPEN && u.send(JSON.stringify(t));
}
function R(t) {
  l.log("keyframe", "request:", t), w({ type: "request_keyframe", reason: t });
}
function E(t, e) {
  r.framesDisplayed += 1, r.lastDisplayedSeq = t, r.decodeQueueSize = e, w({ type: "ack", seq: t, decode_queue_size: e, displayed: !0 }), h({ type: "stats", stats: { ...r } });
}
function he(t) {
  return (t && typeof t == "object" ? t.primaries : void 0) === "display-p3" ? "display-p3" : "srgb";
}
function Q(t) {
  typeof t.codec == "string" && (r.codec = t.codec);
  const e = t.color && typeof t.color == "object" ? t.color.primaries : void 0;
  r.colorSpace = e ?? r.colorSpace ?? "bt709", typeof t.width == "number" && (r.frameWidth = t.width), typeof t.height == "number" && (r.frameHeight = t.height), typeof t.pixel_ratio == "number" && (r.renderPixelRatio = t.pixel_ratio);
}
function ue(t) {
  if (t.type === "pointer_move" || t.type === "pointer_down" || t.type === "pointer_up" || t.type === "wheel") {
    const e = b > 0 ? _ / b : 1, i = m > 0 ? D / m : 1, { x: s, y: o, inside: c } = oe(n.viewportState(), t.x * e, t.y * i);
    return { ...t, x: s, y: o, inside: c, pixel_ratio: C };
  }
  return t;
}
function fe(t) {
  t.type === "config" ? (l.log("config", {
    transport: t.transport,
    codec: t.codec,
    pixel_ratio: t.pixel_ratio,
    color: t.color
  }), typeof t.pixel_ratio == "number" && (C = t.pixel_ratio), t.color && (n == null || n.setColorSpace(he(t.color))), Q(t), h({ type: "state", state: "negotiated" }), h({ type: "stats", stats: { ...r } })) : t.type === "set_quality" ? (r = ie(r, t), h({ type: "stats", stats: { ...r } })) : t.type === "stats" && (r = te(r, t), h({ type: "stats", stats: { ...r } }));
}
async function pe(t) {
  const { header: e, payload: i } = Y(t), s = e.pixel_ratio;
  if (typeof s == "number" && (C = s), Q(e), e.type === "image_frame") {
    const o = e;
    r.transport = "image", l.log("frame", "image", { seq: o.seq, mime: o.mime, bytes: i.byteLength });
    try {
      await re(n, o, i);
    } catch (c) {
      l.error("decode", "image decode failed", c);
      return;
    }
    E(o.seq, 0);
  } else if (e.type === "video_chunk") {
    const o = e;
    r.transport = "webcodecs", l.log("frame", "video", { seq: o.seq, keyframe: o.keyframe, bytes: i.byteLength }), d.handleChunk(o, i);
    const c = d.decodeQueueSize;
    H.shouldRequestKeyframe(c) && R("decode queue backlog");
  }
}
async function M(t) {
  l.log("ws", "connecting", t), S = t, u = new WebSocket(t), u.binaryType = "arraybuffer", h({ type: "state", state: x > 0 ? "reconnecting" : "connecting" }), u.onopen = async () => {
    l.log("ws", "open"), x = 0, h({ type: "state", state: "open" }), d == null || d.reset();
    const e = await V({
      width: b || void 0,
      height: m || void 0,
      imageOnly: p.imageOnly
    });
    l.log("hello", { supported: e.supported, dpr: e.devicePixelRatio }), w({
      type: "hello",
      supported: e.supported,
      device_pixel_ratio: e.devicePixelRatio,
      token: p.token
      // undefined is dropped by JSON.stringify
    }), b > 0 && m > 0 && w({
      type: "set_viewport",
      width: b,
      height: m,
      pwidth: _,
      pheight: D,
      ratio: W
    });
  }, u.onmessage = (e) => {
    if (typeof e.data == "string") {
      fe(JSON.parse(e.data));
      return;
    }
    pe(e.data);
  }, u.onclose = (e) => {
    if (l.log("ws", "closed", { code: e.code, reason: e.reason }), q || ee(e.code)) {
      h({ type: "state", state: "closed" });
      return;
    }
    ge();
  }, u.onerror = () => {
    l.error("ws", "websocket error");
  };
}
function ge() {
  if (q || S === null || k !== null) return;
  const t = Z(x);
  x += 1, l.log("ws", "reconnect scheduled", { attempt: x, delayMs: t }), h({ type: "state", state: "reconnecting" }), k = self.setTimeout(() => {
    k = null, !(q || S === null) && M(S);
  }, t);
}
function ye(t, e) {
  const i = n, s = {
    type: "capture-result",
    id: t,
    lastDisplayedSeq: r.lastDisplayedSeq,
    width: i.canvas.width,
    height: i.canvas.height
  };
  if (e === "blob")
    i.toBlob("image/png").then((o) => h({ ...s, blob: o }));
  else {
    const o = i.readPixels();
    h({ ...s, imageData: o }, [o.data.buffer]);
  }
}
self.onmessage = (t) => {
  const e = t.data;
  switch (e.type) {
    case "init": {
      p = e.options ?? {}, l = P(!!p.debug, "worker"), l.log("init", { backing: [e.backingWidth, e.backingHeight], dpr: e.devicePixelRatio }), b = e.cssWidth, m = e.cssHeight, _ = e.backingWidth, D = e.backingHeight, W = e.devicePixelRatio, n = new ae(e.canvas), p.fit && (n.fit = p.fit), p.background && (n.background = p.background), n.resize(e.backingWidth, e.backingHeight), H = new F({
        maxInflight: p.maxInflight,
        slowDownQueue: p.slowDownQueue,
        keyframeOnDropQueue: p.keyframeOnDropQueue
      }), d = new le(
        n,
        H,
        new N(),
        R,
        (i) => E(i, d.decodeQueueSize),
        l,
        {
          onDecoderReset: () => {
            l.log("recover", "-> decoder_reset (asking server to clear inflight)"), w({ type: "decoder_reset" });
          },
          onRecovered: () => {
            r.recoveries = (r.recoveries ?? 0) + 1, h({ type: "stats", stats: { ...r } });
          },
          onFatal: (i) => h({ type: "error", error: i })
        }
      ), v = self.setInterval(() => d == null ? void 0 : d.checkStall(), 500), h({ type: "ready" }), M(e.url);
      break;
    }
    case "event":
      w({ type: "event", event: ue(e.event) });
      break;
    case "set_fit":
      n && (e.fit && (n.fit = e.fit), e.background !== void 0 && (n.background = e.background));
      break;
    case "resize":
      b = e.cssWidth, m = e.cssHeight, _ = e.backingWidth, D = e.backingHeight, W = e.pixelRatio, n == null || n.resize(e.backingWidth, e.backingHeight), d == null || d.reset(), w({
        type: "set_viewport",
        width: e.cssWidth,
        height: e.cssHeight,
        pwidth: e.backingWidth,
        pheight: e.backingHeight,
        ratio: e.pixelRatio
      }), R("viewport resized");
      break;
    case "capture":
      ye(e.id, e.format);
      break;
    case "dispose":
      q = !0, k !== null && (clearTimeout(k), k = null), v !== null && (clearInterval(v), v = null), d == null || d.close();
      try {
        u == null || u.close();
      } catch {
      }
      u = null;
      break;
  }
};
//# sourceMappingURL=entry-CbrHzFwT.js.map
`, R = typeof self < "u" && self.Blob && new Blob(["URL.revokeObjectURL(import.meta.url);", L], { type: "text/javascript;charset=utf-8" });
function B(t) {
  let e;
  try {
    if (e = R && (self.URL || self.webkitURL).createObjectURL(R), !e) throw "";
    const n = new Worker(e, {
      type: "module",
      name: t == null ? void 0 : t.name
    });
    return n.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(e);
    }), n;
  } catch {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(L),
      {
        type: "module",
        name: t == null ? void 0 : t.name
      }
    );
  }
}
function U() {
  return new B();
}
const j = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
class A {
  constructor(e, n) {
    d(this, "canvas");
    d(this, "worker");
    d(this, "options");
    d(this, "dpr");
    d(this, "backingWidth", 0);
    d(this, "backingHeight", 0);
    d(this, "resizeObserver");
    d(this, "captureWaiters", /* @__PURE__ */ new Map());
    d(this, "captureId", 0);
    d(this, "_lastCaptureSeq", -1);
    d(this, "disposed", !1);
    d(this, "_state", "connecting");
    d(this, "_stats", { ...j });
    d(this, "log");
    d(this, "onPointer", (e) => {
      if (e.type === "pointerdown") {
        this.canvas.focus();
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {
        }
      }
      const n = this.canvas.getBoundingClientRect();
      this.post({ type: "event", event: $(e, n) });
    });
    d(this, "onWheel", (e) => {
      const n = this.canvas.getBoundingClientRect();
      this.post({ type: "event", event: F(e, n) });
    });
    d(this, "onKey", (e) => {
      this.post({ type: "event", event: T(e) });
    });
    this.options = n, this.log = Q(n.debug ?? !1, "view"), this.log.log("init", { url: n.url, fit: n.fit, imageOnly: n.imageOnly }), this.dpr = n.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1, this.canvas = this.resolveCanvas(e), this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0;
    const s = this.canvas.getBoundingClientRect(), i = s.width || this.canvas.clientWidth || 320, r = s.height || this.canvas.clientHeight || 240, c = _(i, r, this.dpr, n.maxBackingDimension);
    this.backingWidth = c.backingWidth, this.backingHeight = c.backingHeight, this.canvas.width = c.backingWidth, this.canvas.height = c.backingHeight;
    const o = this.canvas.transferControlToOffscreen();
    this.worker = (n.workerFactory ?? U)(), this.worker.onmessage = (u) => this.onWorkerMessage(u.data);
    const l = {
      type: "init",
      canvas: o,
      url: n.url,
      devicePixelRatio: this.dpr,
      backingWidth: c.backingWidth,
      backingHeight: c.backingHeight,
      cssWidth: i,
      cssHeight: r,
      options: {
        maxInflight: n.maxInflight,
        imageOnly: n.imageOnly,
        token: n.token,
        fit: n.fit,
        background: n.background,
        debug: n.debug
      }
    };
    this.worker.postMessage(l, [o]), this.attachListeners(), n.autoResize !== !1 && this.observeResize();
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
    var n, s, i, r, c, o;
    switch (e.type) {
      case "state":
        this._state = e.state, this.log.log("state", e.state), (s = (n = this.options).onState) == null || s.call(n, e.state);
        break;
      case "stats":
        this._stats = e.stats, (r = (i = this.options).onStats) == null || r.call(i, e.stats);
        break;
      case "capture-result": {
        this._lastCaptureSeq = e.lastDisplayedSeq;
        const l = this.captureWaiters.get(e.id);
        l && (this.captureWaiters.delete(e.id), l(e.imageData ?? e.blob));
        break;
      }
      case "error":
        this._state = "error", this.log.error("worker", e.error), (o = (c = this.options).onError) == null || o.call(c, new Error(e.error));
        break;
    }
  }
}
new TextDecoder("utf-8");
new TextEncoder();
const W = (t) => t === void 0 ? "—" : `${(t / 1e6).toFixed(1)} Mbps`, H = (t) => t === void 0 ? "—" : `${t.toFixed(0)} ms`, D = (t) => t === void 0 ? "—" : t.toFixed(1);
function M(t) {
  return t === "negotiated" ? "live" : t;
}
function K(t, e) {
  return [
    ["state", M(t)],
    ["transport", e.transport],
    ["displayed", `${e.framesDisplayed} (dropped ${e.framesDropped})`],
    ["decode queue", String(e.decodeQueueSize)],
    ["rtt", H(e.serverRttMs)],
    ["server fps", D(e.serverFpsSent)],
    ["server bitrate", W(e.serverBitrateBps)],
    ["encode", H(e.serverEncodeMs)],
    ["target bitrate", W(e.targetBitrate)],
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
function X(t, e, n) {
  const s = document.createElement("div");
  s.className = "rfb-status";
  const i = document.createElement("div");
  i.className = "rfb-badge", i.style.display = "none";
  const r = document.createElement("pre");
  r.className = "rfb-hud", r.style.display = "none";
  const c = document.createElement("span"), o = document.createElement("div");
  o.className = "rfb-banner", o.setAttribute("role", "alert"), o.style.display = "none", o.append(c, b("↻", "Reconnect", () => n.reconnect()));
  const l = document.createElement("div");
  l.className = "rfb-loading", l.appendChild(Object.assign(document.createElement("div"), { className: "rfb-spinner" }));
  const u = b("📊", "Toggle stats", () => k()), f = document.createElement("div");
  f.className = "rfb-toolbar", f.append(
    u,
    b("⇄", "Toggle transport", () => n.toggleTransport()),
    b("📷", "Screenshot", C),
    b("⛶", "Fullscreen", () => n.fullscreen())
  ), t.append(s, i, f, r, o, l);
  let p = !1, a = "connecting", g = null;
  function C() {
    n.capture("blob").then((h) => {
      const v = URL.createObjectURL(h), y = document.createElement("a");
      y.href = v, y.download = "framebuffer.png", y.click(), setTimeout(() => URL.revokeObjectURL(v), 1e3);
    });
  }
  function k() {
    p = !p, m();
  }
  function m() {
    const h = p && e.get("show_stats") !== !1;
    r.style.display = h ? "" : "none", u.dataset.active = String(p), h && g && (r.textContent = K(a, g).map(([v, y]) => `${v.padEnd(15)}${y}`).join(`
`));
  }
  function x() {
    f.style.display = e.get("show_toolbar") !== !1 ? "" : "none", e.get("show_stats") === !1 && (p = !1), m();
  }
  return x(), {
    setState(h) {
      a = h, s.textContent = M(h), m();
    },
    setStats(h) {
      g = h, h.transport !== "none" && (i.style.display = "", i.textContent = N(h)), h.framesDisplayed > 0 && (l.style.display = "none"), m();
    },
    setError(h) {
      h ? (c.textContent = h.message, o.style.display = "") : o.style.display = "none";
    },
    toggleHud: k,
    refresh: x,
    destroy() {
      for (const h of [s, i, f, r, o, l]) h.remove();
    }
  };
}
function Y(t) {
  const e = t.get("url");
  if (e) return String(e);
  const n = t.get("stream") || "default", s = location.protocol === "https:" ? "wss" : "ws", i = t.get("base_path");
  if (i) {
    const c = String(i).replace(/\/+$/, "");
    return `${s}://${location.host}${c}/${n}`;
  }
  let r = t.get("host");
  return (!r || r === "auto" || r === "0.0.0.0" || r === "::") && (r = location.hostname || "127.0.0.1"), `${s}://${r}:${t.get("port")}/${n}`;
}
const J = {
  render({ model: t, el: e }) {
    e.classList.add("rfb-root"), e.dataset.state = "connecting";
    const n = t.get("height");
    n && (e.style.height = typeof n == "number" ? `${n}px` : String(n));
    const s = document.createElement("div");
    s.className = "rfb-viewport", e.appendChild(s);
    let i = null, r = 0;
    const o = X(e, t, {
      capture: (a) => i ? i.capture(a) : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
      toggleTransport: () => {
        t.set("image_only", !t.get("image_only")), t.save_changes();
      },
      fullscreen: () => {
        var a;
        return void ((a = e.requestFullscreen) == null ? void 0 : a.call(e));
      },
      reconnect: () => u()
    });
    function l(a) {
      const g = performance.now();
      g - r < 1e3 || (r = g, t.set("stats", {
        transport: a.transport,
        framesDisplayed: a.framesDisplayed,
        framesDropped: a.framesDropped,
        decodeQueueSize: a.decodeQueueSize,
        serverFpsSent: a.serverFpsSent ?? null,
        serverRttMs: a.serverRttMs ?? null
      }), t.save_changes());
    }
    function u() {
      i == null || i.dispose(), e.dataset.state = "connecting", i = new A(s, {
        url: Y(t),
        token: t.get("token") || void 0,
        imageOnly: !!t.get("image_only"),
        fit: t.get("fit") || void 0,
        background: t.get("background") || void 0,
        onState: (a) => {
          e.dataset.state = a, t.set("state", a), t.save_changes(), o.setState(a);
        },
        onStats: (a) => {
          o.setStats(a), l(a);
        },
        onError: (a) => {
          t.set("last_error", a.message), t.save_changes(), o.setError(a);
        }
      }), o.setError(null);
    }
    const f = () => u(), p = () => o.refresh();
    for (const a of ["url", "host", "base_path", "port", "stream", "token", "image_only", "fit", "background"])
      t.on(`change:${a}`, f);
    return t.on("change:show_toolbar", p), t.on("change:show_stats", p), u(), () => {
      t.off(null, null), i == null || i.dispose(), i = null, o.destroy(), s.remove(), e.classList.remove("rfb-root"), delete e.dataset.state;
    };
  }
};
export {
  J as default
};
//# sourceMappingURL=widget.js.map
