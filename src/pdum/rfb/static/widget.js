var O = Object.defineProperty;
var P = (t, e, n) => e in t ? O(t, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : t[e] = n;
var c = (t, e, n) => P(t, typeof e != "symbol" ? e + "" : e, n);
function w(t) {
  const e = [];
  return t.shiftKey && e.push("Shift"), t.ctrlKey && e.push("Control"), t.altKey && e.push("Alt"), t.metaKey && e.push("Meta"), e;
}
function $(t) {
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
function q(t, e, n) {
  return { x: t - n.left, y: e - n.top };
}
function S(t, e, n) {
  return e === 1 ? t * 16 : e === 2 ? t * n : t;
}
function T(t, e) {
  const { x: n, y: i } = q(t.clientX, t.clientY, e);
  return {
    type: t.type === "pointerdown" ? "pointer_down" : t.type === "pointerup" ? "pointer_up" : "pointer_move",
    x: n,
    y: i,
    button: $(t.button),
    buttons: L(t.buttons),
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function I(t, e) {
  const { x: n, y: i } = q(t.clientX, t.clientY, e);
  return {
    type: "wheel",
    x: n,
    y: i,
    dx: S(t.deltaX, t.deltaMode, e.width),
    dy: S(t.deltaY, t.deltaMode, e.height),
    buttons: L(t.buttons),
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function U(t) {
  return {
    type: t.type === "keydown" ? "key_down" : "key_up",
    key: t.key,
    code: t.code,
    modifiers: w(t),
    timestamp: t.timeStamp / 1e3
  };
}
function _(t, e, n, i) {
  let s = Math.max(1, Math.round(t * n)), r = Math.max(1, Math.round(e * n)), d = n;
  if (i && Math.max(s, r) > i) {
    const o = i / Math.max(s, r);
    s = Math.max(1, Math.round(s * o)), r = Math.max(1, Math.round(r * o)), d = t > 0 ? s / t : n;
  }
  return { backingWidth: s, backingHeight: r, pixelRatio: d };
}
const R = () => {
};
function B(t, e, n = !0) {
  const i = `[rfb:${e}]`;
  return {
    enabled: t,
    log: t ? (s, ...r) => console.debug(`${i} ${s}`, ...r) : R,
    notice: n ? (s, ...r) => console.info(`${i} ${s}`, ...r) : R,
    error: (s, ...r) => console.error(`${i} ${s}`, ...r)
  };
}
const Q = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  live: ""
};
function A(t, e) {
  let n;
  return t === "closed" || t === "error" ? n = "disconnected" : t === "reconnecting" ? n = "reconnecting" : t === "connecting" || e === 0 ? n = "connecting" : n = "live", { kind: n, state: t, label: Q[n], busy: n !== "disconnected" && n !== "live" };
}
const H = "rfb-status-overlay-styles", j = `
.rfb-status {
  position: absolute; inset: 0; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  color: var(--rfb-status-fg, #f3efe6);
  font: 500 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--rfb-status-scrim, rgba(0, 0, 0, 0.35));
  transition: opacity 0.15s ease;
}
.rfb-status[data-kind="live"] { display: none; }
.rfb-status[data-kind="disconnected"] { background: var(--rfb-status-scrim-error, rgba(45, 12, 8, 0.5)); }
.rfb-status__box {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.7rem; border-radius: 6px;
  background: var(--rfb-status-bg, rgba(0, 0, 0, 0.55));
}
.rfb-status__spinner {
  width: 14px; height: 14px; box-sizing: border-box;
  border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%;
  animation: rfb-status-spin 0.7s linear infinite;
  opacity: 0.9;
}
@keyframes rfb-status-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rfb-status__spinner { animation-duration: 1.6s; } }
`;
function K(t) {
  if (t.getElementById(H)) return;
  const e = t.createElement("style");
  e.id = H, e.textContent = j, t.head.appendChild(e);
}
function N(t) {
  const e = document, n = e.createElement("div");
  if (n.className = "rfb-status__box", t.busy) {
    const s = e.createElement("span");
    s.className = "rfb-status__spinner", n.appendChild(s);
  }
  const i = e.createElement("span");
  return i.className = "rfb-status__label", i.textContent = t.label, n.appendChild(i), n;
}
function X(t, e = N) {
  K(t.ownerDocument);
  const n = t.ownerDocument.createElement("div");
  n.className = "rfb-status", n.setAttribute("aria-live", "polite"), n.dataset.kind = "connecting", t.appendChild(n);
  let i = null;
  return {
    update(s) {
      if (s.kind === i) return;
      i = s.kind, n.dataset.kind = s.kind;
      const r = e(s);
      n.replaceChildren(...r ? [r] : []), n.style.display = r && s.kind !== "live" ? "" : "none";
    },
    destroy() {
      n.remove();
    }
  };
}
const M = `var T = Object.defineProperty;
var z = (t, e, i) => e in t ? T(t, e, { enumerable: !0, configurable: !0, writable: !0, value: i }) : t[e] = i;
var a = (t, e, i) => z(t, typeof e != "symbol" ? e + "" : e, i);
const I = {
  maxInflight: 3,
  slowDownQueue: 3,
  keyframeOnDropQueue: 6
};
class N {
  constructor(e = {}) {
    a(this, "cfg");
    a(this, "queued", []);
    this.cfg = { ...I, ...e };
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
class L {
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
const $ = "image/jpeg", K = "image/png", U = "webcodecs/h264-annexb", V = "avc1.42E01F";
async function X(t, e = 1280, i = 720) {
  const s = globalThis.VideoDecoder;
  if (!s || typeof s.isConfigSupported != "function") return !1;
  try {
    return !!(await s.isConfigSupported({ codec: t, codedWidth: e, codedHeight: i })).supported;
  } catch {
    return !1;
  }
}
async function J(t = {}) {
  const e = [$, K];
  return !t.imageOnly && await X(V, t.width, t.height) && e.push(U), { supported: e, devicePixelRatio: t.devicePixelRatio ?? 1 };
}
const C = () => {
};
function P(t, e, i = !0) {
  const s = \`[rfb:\${e}]\`;
  return {
    enabled: t,
    log: t ? (o, ...n) => console.debug(\`\${s} \${o}\`, ...n) : C,
    notice: i ? (o, ...n) => console.info(\`\${s} \${o}\`, ...n) : C,
    error: (o, ...n) => console.error(\`\${s} \${o}\`, ...n)
  };
}
const Y = new TextDecoder("utf-8");
new TextEncoder();
function j(t) {
  const e = t instanceof Uint8Array ? t : new Uint8Array(t);
  if (e.byteLength < 4)
    throw new Error("buffer too small to contain a header length prefix");
  const s = new DataView(e.buffer, e.byteOffset, e.byteLength).getUint32(0, !0);
  if (e.byteLength < 4 + s)
    throw new Error(\`buffer truncated: need \${4 + s} bytes, have \${e.byteLength}\`);
  const o = JSON.parse(Y.decode(e.subarray(4, 4 + s))), n = e.subarray(4 + s);
  return { header: o, payload: n };
}
const G = 500, Z = 1e4;
function ee(t, e = Math.random) {
  const i = Math.min(Z, G * 2 ** Math.max(0, t));
  return Math.round(i * (0.5 + 0.5 * e()));
}
function te(t) {
  return t === 4401 || t === 4404;
}
function ie(t, e) {
  const i = { ...t };
  return e.rtt_ms !== void 0 && (i.serverRttMs = e.rtt_ms), e.fps_sent !== void 0 && (i.serverFpsSent = e.fps_sent), e.bitrate_bps !== void 0 && (i.serverBitrateBps = e.bitrate_bps), e.encode_ms !== void 0 && (i.serverEncodeMs = e.encode_ms), e.dropped !== void 0 && (i.serverDropped = e.dropped), e.target_bitrate !== void 0 && (i.targetBitrate = e.target_bitrate), e.target_fps !== void 0 && (i.targetFps = e.target_fps), i;
}
function se(t, e) {
  const i = { ...t };
  return e.bitrate !== void 0 && (i.targetBitrate = e.bitrate), e.fps !== void 0 && (i.targetFps = e.fps), i;
}
function oe(t) {
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
  const { scaleX: e, scaleY: i } = oe(t), s = t.frameW * e, o = t.frameH * i, n = (t.backingW - s) / 2, b = (t.backingH - o) / 2;
  return { dx: n, dy: b, dw: s, dh: o };
}
function ae(t, e, i) {
  const { dx: s, dy: o, dw: n, dh: b } = A(t), p = n > 0 ? (e - s) / n * t.frameW : 0, w = b > 0 ? (i - o) / b * t.frameH : 0, B = p >= 0 && p < t.frameW && w >= 0 && w < t.frameH;
  return { x: p, y: w, inside: B };
}
async function re(t, e, i) {
  const s = new Blob([new Uint8Array(i)], { type: e.mime }), o = await createImageBitmap(s);
  try {
    t.draw(o, o.width, o.height);
  } finally {
    o.close();
  }
}
class ne {
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
    // A 1:1 copy of the last decoded frame, kept at native resolution so we can repaint on a
    // display-only resize / fit change WITHOUT a decoder reset (the source VideoFrame is closed
    // right after draw, so we can't reach it later). Lets a resize keep the picture up instead of
    // going blank until the next frame.
    a(this, "lastFrame", null);
    a(this, "lastFrameCtx", null);
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
    e > 0 && i > 0 && (this.canvas.width = e, this.canvas.height = i, this.redraw());
  }
  /** Repaint the last retained frame with the current size/fit (no-op draw if none yet). Used
   *  after a resize or a fit change so the picture updates without waiting for the next frame. */
  redraw() {
    this.paint();
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
    this.frameW = i, this.frameH = s, this.retain(e, i, s), this.paint();
  }
  /** Keep a native-resolution copy of the last frame for repaint-on-resize. */
  retain(e, i, s) {
    var o;
    (!this.lastFrame || this.lastFrame.width !== i || this.lastFrame.height !== s) && (this.lastFrame = new OffscreenCanvas(i, s), this.lastFrameCtx = this.lastFrame.getContext("2d", { colorSpace: this.colorSpace })), (o = this.lastFrameCtx) == null || o.drawImage(e, 0, 0, i, s);
  }
  /** Paint the retained frame onto the canvas with the current size + fit geometry. */
  paint() {
    const e = this.context();
    if (e.fillStyle = this.background, e.fillRect(0, 0, this.canvas.width, this.canvas.height), this.lastFrame) {
      const { dx: i, dy: s, dw: o, dh: n } = A(this.viewportState());
      e.drawImage(this.lastFrame, i, s, o, n);
    }
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
class ce {
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
const de = { enabled: !1, log: () => {
}, notice: () => {
}, error: () => {
} }, le = () => typeof performance < "u" ? performance.now() : Date.now();
class he {
  constructor(e, i, s, o, n, b = de, p = {}) {
    a(this, "decoder", null);
    a(this, "codec", "");
    a(this, "codedWidth", 0);
    a(this, "codedHeight", 0);
    a(this, "lastHeader", null);
    a(this, "watchdog");
    a(this, "hooks");
    this.renderer = e, this.bp = i, this.gate = s, this.onRequestKeyframe = o, this.onDisplayed = n, this.log = b;
    const w = p.now ?? le;
    this.hooks = {
      onDecoderReset: p.onDecoderReset ?? (() => {
      }),
      onRecovered: p.onRecovered ?? (() => {
      }),
      onFatal: p.onFatal ?? (() => {
      }),
      now: w
    }, this.watchdog = new ce(p.stallMs ?? 1200, w, () => this.recover());
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
let u = null, c = null, h = null, H = null, g = 0, y = 0, _ = 0, D = 0, R = 1, W = 1, f = {}, d = P(!1, "worker"), v = null, S = null, q = !1, k = null, x = 0, r = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
function l(t, e = []) {
  self.postMessage(t, e);
}
function m(t) {
  u && u.readyState === WebSocket.OPEN && u.send(JSON.stringify(t));
}
let F = "";
function E(t) {
  t !== F ? d.notice("keyframe", "request:", t) : d.log("keyframe", "request:", t), F = t, m({ type: "request_keyframe", reason: t });
}
function O(t, e) {
  r.framesDisplayed += 1, r.lastDisplayedSeq = t, r.decodeQueueSize = e, m({ type: "ack", seq: t, decode_queue_size: e, displayed: !0 }), l({ type: "stats", stats: { ...r } });
}
function ue(t) {
  return (t && typeof t == "object" ? t.primaries : void 0) === "display-p3" ? "display-p3" : "srgb";
}
function Q(t) {
  typeof t.codec == "string" && (r.codec = t.codec);
  const e = t.color && typeof t.color == "object" ? t.color.primaries : void 0;
  r.colorSpace = e ?? r.colorSpace ?? "bt709", typeof t.width == "number" && (r.frameWidth = t.width), typeof t.height == "number" && (r.frameHeight = t.height), typeof t.pixel_ratio == "number" && (r.renderPixelRatio = t.pixel_ratio);
}
function fe(t) {
  if (t.type === "pointer_move" || t.type === "pointer_down" || t.type === "pointer_up" || t.type === "wheel") {
    const e = g > 0 ? _ / g : 1, i = y > 0 ? D / y : 1, { x: s, y: o, inside: n } = ae(c.viewportState(), t.x * e, t.y * i);
    return { ...t, x: s, y: o, inside: n, pixel_ratio: W };
  }
  return t;
}
function pe(t) {
  t.type === "config" ? (d.notice("negotiated", {
    transport: t.transport,
    codec: t.codec,
    pixel_ratio: t.pixel_ratio,
    color: t.color
  }), typeof t.pixel_ratio == "number" && (W = t.pixel_ratio), t.color && (c == null || c.setColorSpace(ue(t.color))), Q(t), l({ type: "state", state: "negotiated" }), l({ type: "stats", stats: { ...r } })) : t.type === "set_quality" ? (r = se(r, t), l({ type: "stats", stats: { ...r } })) : t.type === "stats" && (r = ie(r, t), l({ type: "stats", stats: { ...r } }));
}
async function ge(t) {
  const { header: e, payload: i } = j(t), s = e.pixel_ratio;
  if (typeof s == "number" && (W = s), Q(e), e.type === "image_frame") {
    const o = e;
    r.transport = "image", d.log("frame", "image", { seq: o.seq, mime: o.mime, bytes: i.byteLength });
    try {
      await re(c, o, i);
    } catch (n) {
      d.error("decode", "image decode failed", n);
      return;
    }
    O(o.seq, 0);
  } else if (e.type === "video_chunk") {
    const o = e;
    r.transport = "webcodecs", d.log("frame", "video", { seq: o.seq, keyframe: o.keyframe, bytes: i.byteLength }), h.handleChunk(o, i);
    const n = h.decodeQueueSize;
    H.shouldRequestKeyframe(n) && E("decode queue backlog");
  }
}
async function M(t) {
  d.log("ws", "connecting", t), S = t, u = new WebSocket(t), u.binaryType = "arraybuffer", l({ type: "state", state: x > 0 ? "reconnecting" : "connecting" }), u.onopen = async () => {
    d.notice("ws", "open"), x = 0, l({ type: "state", state: "open" }), h == null || h.reset();
    const e = await J({
      width: g || void 0,
      height: y || void 0,
      imageOnly: f.imageOnly
    });
    d.log("hello", { supported: e.supported, dpr: e.devicePixelRatio }), m({
      type: "hello",
      supported: e.supported,
      device_pixel_ratio: e.devicePixelRatio,
      token: f.token
      // undefined is dropped by JSON.stringify
    }), g > 0 && y > 0 && m({
      type: "set_viewport",
      width: g,
      height: y,
      pwidth: _,
      pheight: D,
      ratio: R
    });
  }, u.onmessage = (e) => {
    if (typeof e.data == "string") {
      pe(JSON.parse(e.data));
      return;
    }
    ge(e.data);
  }, u.onclose = (e) => {
    if (d.notice("ws", "closed", { code: e.code, reason: e.reason }), q || te(e.code)) {
      l({ type: "state", state: "closed" });
      return;
    }
    ye();
  }, u.onerror = () => {
    d.error("ws", "websocket error");
  };
}
function ye() {
  if (q || S === null || k !== null) return;
  const t = ee(x);
  x += 1, d.notice("ws", "reconnect scheduled", { attempt: x, delayMs: t }), l({ type: "state", state: "reconnecting" }), k = self.setTimeout(() => {
    k = null, !(q || S === null) && M(S);
  }, t);
}
function me(t, e) {
  const i = c, s = {
    type: "capture-result",
    id: t,
    lastDisplayedSeq: r.lastDisplayedSeq,
    width: i.canvas.width,
    height: i.canvas.height
  };
  if (e === "blob")
    i.toBlob("image/png").then((o) => l({ ...s, blob: o }));
  else {
    const o = i.readPixels();
    l({ ...s, imageData: o }, [o.data.buffer]);
  }
}
self.onmessage = (t) => {
  const e = t.data;
  switch (e.type) {
    case "init": {
      f = e.options ?? {}, d = P(!!f.debug, "worker", f.notice ?? !0), d.log("init", { backing: [e.backingWidth, e.backingHeight], dpr: e.devicePixelRatio }), g = e.cssWidth, y = e.cssHeight, _ = e.backingWidth, D = e.backingHeight, R = e.devicePixelRatio, c = new ne(e.canvas), f.fit && (c.fit = f.fit), f.background && (c.background = f.background), c.resize(e.backingWidth, e.backingHeight), H = new N({
        maxInflight: f.maxInflight,
        slowDownQueue: f.slowDownQueue,
        keyframeOnDropQueue: f.keyframeOnDropQueue
      }), h = new he(
        c,
        H,
        new L(),
        E,
        (i) => O(i, h.decodeQueueSize),
        d,
        {
          onDecoderReset: () => {
            d.notice("recover", "decoder reset — asking server to clear inflight"), m({ type: "decoder_reset" });
          },
          onRecovered: () => {
            r.recoveries = (r.recoveries ?? 0) + 1, l({ type: "stats", stats: { ...r } });
          },
          onFatal: (i) => l({ type: "error", error: i })
        }
      ), v = self.setInterval(() => h == null ? void 0 : h.checkStall(), 500), l({ type: "ready" }), M(e.url);
      break;
    }
    case "event":
      m({ type: "event", event: fe(e.event) });
      break;
    case "set_fit":
      c && (e.fit && (c.fit = e.fit), e.background !== void 0 && (c.background = e.background), c.redraw());
      break;
    case "resize":
      d.notice("resize", { backing: [e.backingWidth, e.backingHeight], css: [e.cssWidth, e.cssHeight] }), g = e.cssWidth, y = e.cssHeight, _ = e.backingWidth, D = e.backingHeight, R = e.pixelRatio, c == null || c.resize(e.backingWidth, e.backingHeight), m({
        type: "set_viewport",
        width: e.cssWidth,
        height: e.cssHeight,
        pwidth: e.backingWidth,
        pheight: e.backingHeight,
        ratio: e.pixelRatio
      });
      break;
    case "capture":
      me(e.id, e.format);
      break;
    case "dispose":
      q = !0, k !== null && (clearTimeout(k), k = null), v !== null && (clearInterval(v), v = null), h == null || h.close();
      try {
        u == null || u.close();
      } catch {
      }
      u = null;
      break;
  }
};
//# sourceMappingURL=entry-D4wTK6cy.js.map
`, W = typeof self < "u" && self.Blob && new Blob(["URL.revokeObjectURL(import.meta.url);", M], { type: "text/javascript;charset=utf-8" });
function Y(t) {
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
      "data:text/javascript;charset=utf-8," + encodeURIComponent(M),
      {
        type: "module",
        name: t == null ? void 0 : t.name
      }
    );
  }
}
function V() {
  return new Y();
}
const J = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
class G {
  constructor(e, n) {
    c(this, "canvas");
    c(this, "worker");
    c(this, "options");
    c(this, "dpr");
    c(this, "backingWidth", 0);
    c(this, "backingHeight", 0);
    c(this, "resizeObserver");
    c(this, "captureWaiters", /* @__PURE__ */ new Map());
    c(this, "captureId", 0);
    c(this, "_lastCaptureSeq", -1);
    c(this, "disposed", !1);
    c(this, "_state", "connecting");
    c(this, "_stats", { ...J });
    c(this, "log");
    // Status overlay: shown over the canvas during connect / reconnect / disconnect (and until the
    // first frame arrives). A display resize repaints the retained frame in place — no blank — so
    // it needs no overlay state of its own.
    c(this, "overlayHost", null);
    c(this, "overlay", null);
    c(this, "onPointer", (e) => {
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
    c(this, "onWheel", (e) => {
      const n = this.canvas.getBoundingClientRect();
      this.post({ type: "event", event: I(e, n) });
    });
    c(this, "onKey", (e) => {
      this.post({ type: "event", event: U(e) });
    });
    this.options = n, this.log = B(n.debug ?? !1, "view", n.notice ?? !0), this.log.log("init", { url: n.url, fit: n.fit, imageOnly: n.imageOnly }), this.dpr = n.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1, this.canvas = this.resolveCanvas(e), this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0, this.setupOverlay();
    const i = this.canvas.getBoundingClientRect(), s = i.width || this.canvas.clientWidth || 320, r = i.height || this.canvas.clientHeight || 240, d = _(s, r, this.dpr, n.maxBackingDimension);
    this.backingWidth = d.backingWidth, this.backingHeight = d.backingHeight, this.canvas.width = d.backingWidth, this.canvas.height = d.backingHeight;
    const o = this.canvas.transferControlToOffscreen();
    this.worker = (n.workerFactory ?? V)(), this.worker.onmessage = (u) => this.onWorkerMessage(u.data);
    const h = {
      type: "init",
      canvas: o,
      url: n.url,
      devicePixelRatio: this.dpr,
      backingWidth: d.backingWidth,
      backingHeight: d.backingHeight,
      cssWidth: s,
      cssHeight: r,
      options: {
        maxInflight: n.maxInflight,
        imageOnly: n.imageOnly,
        token: n.token,
        fit: n.fit,
        background: n.background,
        debug: n.debug,
        notice: n.notice
      }
    };
    this.worker.postMessage(h, [o]), this.attachListeners(), n.autoResize !== !1 && this.observeResize();
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
    return new Promise((i) => {
      this.captureWaiters.set(n, i), this.post({ type: "capture", id: n, format: e });
    });
  }
  dispose() {
    var e, n;
    this.disposed || (this.disposed = !0, (e = this.resizeObserver) == null || e.disconnect(), this.detachListeners(), (n = this.overlay) == null || n.destroy(), this.post({ type: "dispose" }), this.worker.terminate(), this.captureWaiters.clear());
  }
  // --- internals ----------------------------------------------------------
  resolveCanvas(e) {
    if (e instanceof HTMLCanvasElement)
      return this.overlayHost = e.parentElement, e;
    const n = e.ownerDocument.createElement("canvas");
    return n.style.width = "100%", n.style.height = "100%", n.style.display = "block", e.appendChild(n), this.overlayHost = e, n;
  }
  /** Mount the on-canvas status overlay (unless disabled or no positioned host is available). */
  setupOverlay() {
    if (this.options.statusOverlay === !1 || !this.overlayHost) return;
    getComputedStyle(this.overlayHost).position === "static" && (this.overlayHost.style.position = "relative");
    const e = typeof this.options.statusOverlay == "function" ? this.options.statusOverlay : void 0;
    this.overlay = X(this.overlayHost, e), this.refreshStatus();
  }
  /** Recompute + apply the overlay status from the current connection state / frame count. */
  refreshStatus() {
    var e;
    (e = this.overlay) == null || e.update(A(this._state, this._stats.framesDisplayed));
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
    var n, i, s, r, d, o;
    switch (e.type) {
      case "state":
        this._state = e.state, this.log.log("state", e.state), this.refreshStatus(), (i = (n = this.options).onState) == null || i.call(n, e.state);
        break;
      case "stats":
        this._stats = e.stats, this.refreshStatus(), (r = (s = this.options).onStats) == null || r.call(s, e.stats);
        break;
      case "capture-result": {
        this._lastCaptureSeq = e.lastDisplayedSeq;
        const h = this.captureWaiters.get(e.id);
        h && (this.captureWaiters.delete(e.id), h(e.imageData ?? e.blob));
        break;
      }
      case "error":
        this._state = "error", this.log.error("worker", e.error), (o = (d = this.options).onError) == null || o.call(d, new Error(e.error));
        break;
    }
  }
}
new TextDecoder("utf-8");
new TextEncoder();
const D = (t) => t === void 0 ? "—" : `${(t / 1e6).toFixed(1)} Mbps`, E = (t) => t === void 0 ? "—" : `${t.toFixed(0)} ms`, C = (t) => t === void 0 ? "—" : t.toFixed(1);
function z(t) {
  return t === "negotiated" ? "live" : t;
}
function Z(t, e) {
  return [
    ["state", z(t)],
    ["transport", e.transport],
    ["displayed", `${e.framesDisplayed} (dropped ${e.framesDropped})`],
    ["decode queue", String(e.decodeQueueSize)],
    ["rtt", E(e.serverRttMs)],
    ["server fps", C(e.serverFpsSent)],
    ["server bitrate", D(e.serverBitrateBps)],
    ["encode", E(e.serverEncodeMs)],
    ["target bitrate", D(e.targetBitrate)],
    ["target fps", C(e.targetFps)]
  ];
}
function ee(t) {
  const n = [t.transport === "webcodecs" ? "H.264" : t.transport === "image" ? "IMG" : "—"];
  return t.serverFpsSent !== void 0 && n.push(`${t.serverFpsSent.toFixed(0)} fps`), t.serverRttMs !== void 0 && n.push(`${t.serverRttMs.toFixed(0)} ms`), n.join(" · ");
}
function m(t, e, n) {
  const i = document.createElement("button");
  return i.type = "button", i.className = "rfb-button", i.title = e, i.textContent = t, i.addEventListener("click", n), i;
}
function te(t, e, n) {
  const i = document.createElement("div");
  i.className = "rfb-status";
  const s = document.createElement("div");
  s.className = "rfb-badge", s.style.display = "none";
  const r = document.createElement("pre");
  r.className = "rfb-hud", r.style.display = "none";
  const d = document.createElement("span"), o = document.createElement("div");
  o.className = "rfb-banner", o.setAttribute("role", "alert"), o.style.display = "none", o.append(d, m("↻", "Reconnect", () => n.reconnect()));
  const h = document.createElement("div");
  h.className = "rfb-loading", h.appendChild(Object.assign(document.createElement("div"), { className: "rfb-spinner" }));
  const u = m("📊", "Toggle stats", () => k()), f = document.createElement("div");
  f.className = "rfb-toolbar", f.append(
    u,
    m("⇄", "Toggle transport", () => n.toggleTransport()),
    m("📷", "Screenshot", F),
    m("⛶", "Fullscreen", () => n.fullscreen())
  ), t.append(i, s, f, r, o, h);
  let p = !1, a = "connecting", g = null;
  function F() {
    n.capture("blob").then((l) => {
      const v = URL.createObjectURL(l), y = document.createElement("a");
      y.href = v, y.download = "framebuffer.png", y.click(), setTimeout(() => URL.revokeObjectURL(v), 1e3);
    });
  }
  function k() {
    p = !p, b();
  }
  function b() {
    const l = p && e.get("show_stats") !== !1;
    r.style.display = l ? "" : "none", u.dataset.active = String(p), l && g && (r.textContent = Z(a, g).map(([v, y]) => `${v.padEnd(15)}${y}`).join(`
`));
  }
  function x() {
    f.style.display = e.get("show_toolbar") !== !1 ? "" : "none", e.get("show_stats") === !1 && (p = !1), b();
  }
  return x(), {
    setState(l) {
      a = l, i.textContent = z(l), b();
    },
    setStats(l) {
      g = l, l.transport !== "none" && (s.style.display = "", s.textContent = ee(l)), l.framesDisplayed > 0 && (h.style.display = "none"), b();
    },
    setError(l) {
      l ? (d.textContent = l.message, o.style.display = "") : o.style.display = "none";
    },
    toggleHud: k,
    refresh: x,
    destroy() {
      for (const l of [i, s, f, r, o, h]) l.remove();
    }
  };
}
function ne(t) {
  const e = t.get("url");
  if (e) return String(e);
  const n = t.get("stream") || "default", i = location.protocol === "https:" ? "wss" : "ws", s = t.get("base_path");
  if (s) {
    const d = String(s).replace(/\/+$/, "");
    return `${i}://${location.host}${d}/${n}`;
  }
  let r = t.get("host");
  return (!r || r === "auto" || r === "0.0.0.0" || r === "::") && (r = location.hostname || "127.0.0.1"), `${i}://${r}:${t.get("port")}/${n}`;
}
const ie = {
  render({ model: t, el: e }) {
    e.classList.add("rfb-root"), e.dataset.state = "connecting";
    const n = t.get("height");
    n && (e.style.height = typeof n == "number" ? `${n}px` : String(n));
    const i = document.createElement("div");
    i.className = "rfb-viewport", e.appendChild(i);
    let s = null, r = 0;
    const o = te(e, t, {
      capture: (a) => s ? s.capture(a) : Promise.reject(new Error("RemoteFramebuffer is not ready yet")),
      toggleTransport: () => {
        t.set("image_only", !t.get("image_only")), t.save_changes();
      },
      fullscreen: () => {
        var a;
        return void ((a = e.requestFullscreen) == null ? void 0 : a.call(e));
      },
      reconnect: () => u()
    });
    function h(a) {
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
      s == null || s.dispose(), e.dataset.state = "connecting", s = new G(i, {
        url: ne(t),
        token: t.get("token") || void 0,
        imageOnly: !!t.get("image_only"),
        fit: t.get("fit") || void 0,
        background: t.get("background") || void 0,
        onState: (a) => {
          e.dataset.state = a, t.set("state", a), t.save_changes(), o.setState(a);
        },
        onStats: (a) => {
          o.setStats(a), h(a);
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
      t.off(null, null), s == null || s.dispose(), s = null, o.destroy(), i.remove(), e.classList.remove("rfb-root"), delete e.dataset.state;
    };
  }
};
export {
  ie as default
};
//# sourceMappingURL=widget.js.map
