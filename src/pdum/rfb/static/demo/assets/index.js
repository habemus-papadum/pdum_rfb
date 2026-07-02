const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./client.js","./index3.js","./index2.js","./reactViewer.js"])))=>i.map(i=>d[i]);
(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))i(n);new MutationObserver(n=>{for(const r of n)if(r.type==="childList")for(const o of r.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&i(o)}).observe(document,{childList:!0,subtree:!0});function s(n){const r={};return n.integrity&&(r.integrity=n.integrity),n.referrerPolicy&&(r.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?r.credentials="include":n.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function i(n){if(n.ep)return;n.ep=!0;const r=s(n);fetch(n.href,r)}})();const I=e=>e===void 0?"—":`${(e/1e6).toFixed(1)} Mbps`,A=e=>e===void 0?"—":`${e.toFixed(0)} ms`,N=e=>e===void 0?"—":e.toFixed(1);function te(e){switch(e){case"open":case"negotiated":return"open";case"error":return"error";case"closed":return"closed";default:return"connecting"}}function G(e){return e==="negotiated"?"live":e}function se(e,t){return[["state",G(e)],["transport",t.transport],["displayed",`${t.framesDisplayed} (dropped ${t.framesDropped})`],["decode queue",String(t.decodeQueueSize)],["rtt",A(t.serverRttMs)],["server fps",N(t.serverFpsSent)],["server bitrate",I(t.serverBitrateBps)],["encode",A(t.serverEncodeMs)],["target bitrate",I(t.targetBitrate)],["target fps",N(t.targetFps)]]}async function v(e,t,s){const i=await fetch(t,{method:e,headers:s!==void 0?{"content-type":"application/json"}:void 0,body:s!==void 0?JSON.stringify(s):void 0}),n=await i.text(),r=n?JSON.parse(n):{};if(!i.ok)throw new Error(r.error??`${i.status} ${i.statusText}`);return r}const h={capabilities:()=>v("GET","/demo/capabilities"),state:()=>v("GET","/demo/state"),createStream:e=>v("POST","/demo/streams",e),deleteStream:e=>v("DELETE",`/demo/streams/${e}`),setScene:(e,t)=>v("POST",`/demo/streams/${e}/scene`,{key:t}),setBackend:(e,t)=>v("POST",`/demo/streams/${e}/backend`,{id:t}),setQuality:(e,t)=>v("POST",`/demo/streams/${e}/quality`,t),setParams:(e,t)=>v("POST",`/demo/streams/${e}/params`,t)};function ie(e){return`${location.protocol==="https:"?"wss":"ws"}://${location.host}/rfb/${e}`}function a(e,t={},s=[]){const i=document.createElement(e);for(const[n,r]of Object.entries(t))r==null||r===!1||(n==="class"?i.className=String(r):n==="text"?i.textContent=String(r):n==="html"?i.innerHTML=String(r):n.startsWith("on")&&typeof r=="function"?i.addEventListener(n.slice(2).toLowerCase(),r):n==="value"?i.value=String(r):r===!0?i.setAttribute(n,""):i.setAttribute(n,String(r)));for(const n of s)i.append(n);return i}function p(e,t,s,i=!1){const n=a("label",{text:e});return s&&n.append(a("span",{class:"help",tabindex:"0",role:"note","aria-label":s},["?",a("span",{class:"help__tip",role:"tooltip",text:s})])),a("div",{class:i?"field field--wide":"field"},[n,t])}function H(e){for(;e.firstChild;)e.removeChild(e.firstChild)}const re="modulepreload",ne=function(e,t){return new URL(e,t).href},U={},$=function(t,s,i){let n=Promise.resolve();if(s&&s.length>0){let o=function(d){return Promise.all(d.map(y=>Promise.resolve(y).then(x=>({status:"fulfilled",value:x}),x=>({status:"rejected",reason:x}))))};const c=document.getElementsByTagName("link"),g=document.querySelector("meta[property=csp-nonce]"),l=g?.nonce||g?.getAttribute("nonce");n=o(s.map(d=>{if(d=ne(d,i),d in U)return;U[d]=!0;const y=d.endsWith(".css"),x=y?'[rel="stylesheet"]':"";if(!!i)for(let S=c.length-1;S>=0;S--){const W=c[S];if(W.href===d&&(!y||W.rel==="stylesheet"))return}else if(document.querySelector(`link[href="${d}"]${x}`))return;const b=document.createElement("link");if(b.rel=y?"stylesheet":re,y||(b.as="script"),b.crossOrigin="",b.href=d,l&&b.setAttribute("nonce",l),document.head.appendChild(b),y)return new Promise((S,W)=>{b.addEventListener("load",S),b.addEventListener("error",()=>W(new Error(`Unable to preload CSS for ${d}`)))})}))}function r(o){const c=new Event("vite:preloadError",{cancelable:!0});if(c.payload=o,window.dispatchEvent(c),!c.defaultPrevented)throw o}return n.then(o=>{for(const c of o||[])c.status==="rejected"&&r(c.reason);return t().catch(r)})};var ae=Object.defineProperty,oe=(e,t,s)=>t in e?ae(e,t,{enumerable:!0,configurable:!0,writable:!0,value:s}):e[t]=s,u=(e,t,s)=>oe(e,typeof t!="symbol"?t+"":t,s);function B(e){const t=[];return e.shiftKey&&t.push("Shift"),e.ctrlKey&&t.push("Control"),e.altKey&&t.push("Alt"),e.metaKey&&t.push("Meta"),t}function ce(e){switch(e){case 0:return 1;case 1:return 3;case 2:return 2;case 3:return 4;case 4:return 5;default:return 0}}function X(e){const t=[];return e&1&&t.push(1),e&2&&t.push(2),e&4&&t.push(3),e&8&&t.push(4),e&16&&t.push(5),t}function Y(e,t,s){return{x:e-s.left,y:t-s.top}}function Q(e,t,s){return t===1?e*16:t===2?e*s:e}function le(e,t){const{x:s,y:i}=Y(e.clientX,e.clientY,t);return{type:e.type==="pointerdown"?"pointer_down":e.type==="pointerup"?"pointer_up":"pointer_move",x:s,y:i,button:ce(e.button),buttons:X(e.buttons),modifiers:B(e),timestamp:e.timeStamp/1e3}}function de(e,t){const{x:s,y:i}=Y(e.clientX,e.clientY,t);return{type:"wheel",x:s,y:i,dx:Q(e.deltaX,e.deltaMode,t.width),dy:Q(e.deltaY,e.deltaMode,t.height),buttons:X(e.buttons),modifiers:B(e),timestamp:e.timeStamp/1e3}}function ue(e){return{type:e.type==="keydown"?"key_down":"key_up",key:e.key,code:e.code,modifiers:B(e),timestamp:e.timeStamp/1e3}}function j(e,t,s,i){let n=Math.max(1,Math.round(e*s)),r=Math.max(1,Math.round(t*s)),o=s;if(i&&Math.max(n,r)>i){const c=i/Math.max(n,r);n=Math.max(1,Math.round(n*c)),r=Math.max(1,Math.round(r*c)),o=e>0?n/e:s}return{backingWidth:n,backingHeight:r,pixelRatio:o}}const he=()=>{};function pe(e,t){const s=`[rfb:${t}]`;return{enabled:e,log:e?(i,...n)=>console.debug(`${s} ${i}`,...n):he,error:(i,...n)=>console.error(`${s} ${i}`,...n)}}const J=`var C = Object.defineProperty;
var Q = (t, e, i) => e in t ? C(t, e, { enumerable: !0, configurable: !0, writable: !0, value: i }) : t[e] = i;
var r = (t, e, i) => Q(t, typeof e != "symbol" ? e + "" : e, i);
const A = {
  maxInflight: 3,
  slowDownQueue: 3,
  keyframeOnDropQueue: 6
};
class O {
  constructor(e = {}) {
    r(this, "cfg");
    r(this, "queued", []);
    this.cfg = { ...A, ...e };
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
class B {
  constructor() {
    r(this, "armed", !0);
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
const E = "image/jpeg", z = "image/png", F = "webcodecs/h264-annexb", L = "avc1.42E01F";
async function I(t, e = 1280, i = 720) {
  const s = globalThis.VideoDecoder;
  if (!s || typeof s.isConfigSupported != "function") return !1;
  try {
    return !!(await s.isConfigSupported({ codec: t, codedWidth: e, codedHeight: i })).supported;
  } catch {
    return !1;
  }
}
async function K(t = {}) {
  const e = [E, z];
  return !t.imageOnly && await I(L, t.width, t.height) && e.push(F), { supported: e, devicePixelRatio: t.devicePixelRatio ?? 1 };
}
const M = () => {
};
function H(t, e) {
  const i = \`[rfb:\${e}]\`;
  return {
    enabled: t,
    log: t ? (s, ...o) => console.debug(\`\${i} \${s}\`, ...o) : M,
    error: (s, ...o) => console.error(\`\${i} \${s}\`, ...o)
  };
}
const T = new TextDecoder("utf-8");
new TextEncoder();
function $(t) {
  const e = t instanceof Uint8Array ? t : new Uint8Array(t);
  if (e.byteLength < 4)
    throw new Error("buffer too small to contain a header length prefix");
  const s = new DataView(e.buffer, e.byteOffset, e.byteLength).getUint32(0, !0);
  if (e.byteLength < 4 + s)
    throw new Error(\`buffer truncated: need \${4 + s} bytes, have \${e.byteLength}\`);
  const o = JSON.parse(T.decode(e.subarray(4, 4 + s))), n = e.subarray(4 + s);
  return { header: o, payload: n };
}
function N(t, e) {
  const i = { ...t };
  return e.rtt_ms !== void 0 && (i.serverRttMs = e.rtt_ms), e.fps_sent !== void 0 && (i.serverFpsSent = e.fps_sent), e.bitrate_bps !== void 0 && (i.serverBitrateBps = e.bitrate_bps), e.encode_ms !== void 0 && (i.serverEncodeMs = e.encode_ms), e.dropped !== void 0 && (i.serverDropped = e.dropped), e.target_bitrate !== void 0 && (i.targetBitrate = e.target_bitrate), e.target_fps !== void 0 && (i.targetFps = e.target_fps), i;
}
function U(t, e) {
  const i = { ...t };
  return e.bitrate !== void 0 && (i.targetBitrate = e.bitrate), e.fps !== void 0 && (i.targetFps = e.fps), i;
}
function V(t) {
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
function W(t) {
  const { scaleX: e, scaleY: i } = V(t), s = t.frameW * e, o = t.frameH * i, n = (t.backingW - s) / 2, g = (t.backingH - o) / 2;
  return { dx: n, dy: g, dw: s, dh: o };
}
function X(t, e, i) {
  const { dx: s, dy: o, dw: n, dh: g } = W(t), f = n > 0 ? (e - s) / n * t.frameW : 0, y = g > 0 ? (i - o) / g * t.frameH : 0, P = f >= 0 && f < t.frameW && y >= 0 && y < t.frameH;
  return { x: f, y, inside: P };
}
async function J(t, e, i) {
  const s = new Blob([new Uint8Array(i)], { type: e.mime }), o = await createImageBitmap(s);
  try {
    t.draw(o, o.width, o.height);
  } finally {
    o.close();
  }
}
class Y {
  constructor(e) {
    // Lazily created so the color space (from the server \`config\`, which arrives before
    // the first frame) can be chosen at getContext time — a 2D context's colorSpace is
    // fixed at creation and cannot be changed afterwards.
    r(this, "ctx", null);
    r(this, "colorSpace", "srgb");
    /** Fit mode when the frame AR differs from the canvas AR (default letterbox). */
    r(this, "fit", "contain");
    /** Letterbox fill for \`contain\` (any CSS color; default black). */
    r(this, "background", "#000");
    /** Current decoded frame size (device px), updated on each draw. */
    r(this, "frameW", 0);
    r(this, "frameH", 0);
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
    const { dx: n, dy: g, dw: f, dh: y } = W(this.viewportState());
    o.drawImage(e, n, g, f, y);
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
class G {
  /**
   * @param stallMs  how long a backlog may sit with zero new output before it's a stall.
   * @param now      monotonic clock in ms (inject \`performance.now\`; overridable for tests).
   * @param onStall  fired once per stall edge (check() also returns true on that edge).
   */
  constructor(e, i, s) {
    r(this, "queued", 0);
    r(this, "displayed", 0);
    /** Wall-clock when the current outstanding backlog began (\`null\` = nothing pending).
     *  A nullable — not a 0 sentinel — so a legitimate timestamp of 0 isn't read as "idle". */
    r(this, "oldestPendingAt", null);
    r(this, "stalled", !1);
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
const j = { enabled: !1, log: () => {
}, error: () => {
} }, Z = () => typeof performance < "u" ? performance.now() : Date.now();
class ee {
  constructor(e, i, s, o, n, g = j, f = {}) {
    r(this, "decoder", null);
    r(this, "codec", "");
    r(this, "codedWidth", 0);
    r(this, "codedHeight", 0);
    r(this, "lastHeader", null);
    r(this, "watchdog");
    r(this, "hooks");
    this.renderer = e, this.bp = i, this.gate = s, this.onRequestKeyframe = o, this.onDisplayed = n, this.log = g;
    const y = f.now ?? Z;
    this.hooks = {
      onDecoderReset: f.onDecoderReset ?? (() => {
      }),
      onRecovered: f.onRecovered ?? (() => {
      }),
      onFatal: f.onFatal ?? (() => {
      }),
      now: y
    }, this.watchdog = new G(f.stallMs ?? 1200, y, () => this.recover());
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
let h = null, a = null, c = null, D = null, b = 0, w = 0, v = 0, x = 0, S = 1, q = 1, p = {}, l = H(!1, "worker"), k = null, d = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
function u(t, e = []) {
  self.postMessage(t, e);
}
function m(t) {
  h && h.readyState === WebSocket.OPEN && h.send(JSON.stringify(t));
}
function _(t) {
  l.log("keyframe", "request:", t), m({ type: "request_keyframe", reason: t });
}
function R(t, e) {
  d.framesDisplayed += 1, d.lastDisplayedSeq = t, d.decodeQueueSize = e, m({ type: "ack", seq: t, decode_queue_size: e, displayed: !0 }), u({ type: "stats", stats: { ...d } });
}
function te(t) {
  return (t && typeof t == "object" ? t.primaries : void 0) === "display-p3" ? "display-p3" : "srgb";
}
function ie(t) {
  if (t.type === "pointer_move" || t.type === "pointer_down" || t.type === "pointer_up" || t.type === "wheel") {
    const e = b > 0 ? v / b : 1, i = w > 0 ? x / w : 1, { x: s, y: o, inside: n } = X(a.viewportState(), t.x * e, t.y * i);
    return { ...t, x: s, y: o, inside: n, pixel_ratio: q };
  }
  return t;
}
function se(t) {
  t.type === "config" ? (l.log("config", {
    transport: t.transport,
    codec: t.codec,
    pixel_ratio: t.pixel_ratio,
    color: t.color
  }), typeof t.pixel_ratio == "number" && (q = t.pixel_ratio), t.color && (a == null || a.setColorSpace(te(t.color))), u({ type: "state", state: "negotiated" })) : t.type === "set_quality" ? (d = U(d, t), u({ type: "stats", stats: { ...d } })) : t.type === "stats" && (d = N(d, t), u({ type: "stats", stats: { ...d } }));
}
async function oe(t) {
  const { header: e, payload: i } = $(t), s = e.pixel_ratio;
  if (typeof s == "number" && (q = s), e.type === "image_frame") {
    const o = e;
    d.transport = "image", l.log("frame", "image", { seq: o.seq, mime: o.mime, bytes: i.byteLength });
    try {
      await J(a, o, i);
    } catch (n) {
      l.error("decode", "image decode failed", n);
      return;
    }
    R(o.seq, 0);
  } else if (e.type === "video_chunk") {
    const o = e;
    d.transport = "webcodecs", l.log("frame", "video", { seq: o.seq, keyframe: o.keyframe, bytes: i.byteLength }), c.handleChunk(o, i);
    const n = c.decodeQueueSize;
    D.shouldRequestKeyframe(n) && _("decode queue backlog");
  }
}
async function re(t) {
  l.log("ws", "connecting", t), h = new WebSocket(t), h.binaryType = "arraybuffer", u({ type: "state", state: "connecting" }), h.onopen = async () => {
    l.log("ws", "open"), u({ type: "state", state: "open" }), c == null || c.reset();
    const e = await K({
      width: b || void 0,
      height: w || void 0,
      imageOnly: p.imageOnly
    });
    l.log("hello", { supported: e.supported, dpr: e.devicePixelRatio }), m({
      type: "hello",
      supported: e.supported,
      device_pixel_ratio: e.devicePixelRatio,
      token: p.token
      // undefined is dropped by JSON.stringify
    }), b > 0 && w > 0 && m({
      type: "set_viewport",
      width: b,
      height: w,
      pwidth: v,
      pheight: x,
      ratio: S
    });
  }, h.onmessage = (e) => {
    if (typeof e.data == "string") {
      se(JSON.parse(e.data));
      return;
    }
    oe(e.data);
  }, h.onclose = (e) => {
    l.log("ws", "closed", { code: e.code, reason: e.reason }), u({ type: "state", state: "closed" });
  }, h.onerror = () => {
    l.error("ws", "websocket error"), u({ type: "error", error: "websocket error" });
  };
}
function ae(t, e) {
  const i = a, s = {
    type: "capture-result",
    id: t,
    lastDisplayedSeq: d.lastDisplayedSeq,
    width: i.canvas.width,
    height: i.canvas.height
  };
  if (e === "blob")
    i.toBlob("image/png").then((o) => u({ ...s, blob: o }));
  else {
    const o = i.readPixels();
    u({ ...s, imageData: o }, [o.data.buffer]);
  }
}
self.onmessage = (t) => {
  const e = t.data;
  switch (e.type) {
    case "init": {
      p = e.options ?? {}, l = H(!!p.debug, "worker"), l.log("init", { backing: [e.backingWidth, e.backingHeight], dpr: e.devicePixelRatio }), b = e.cssWidth, w = e.cssHeight, v = e.backingWidth, x = e.backingHeight, S = e.devicePixelRatio, a = new Y(e.canvas), p.fit && (a.fit = p.fit), p.background && (a.background = p.background), a.resize(e.backingWidth, e.backingHeight), D = new O({
        maxInflight: p.maxInflight,
        slowDownQueue: p.slowDownQueue,
        keyframeOnDropQueue: p.keyframeOnDropQueue
      }), c = new ee(
        a,
        D,
        new B(),
        _,
        (i) => R(i, c.decodeQueueSize),
        l,
        {
          onDecoderReset: () => {
            l.log("recover", "-> decoder_reset (asking server to clear inflight)"), m({ type: "decoder_reset" });
          },
          onRecovered: () => {
            d.recoveries = (d.recoveries ?? 0) + 1, u({ type: "stats", stats: { ...d } });
          },
          onFatal: (i) => u({ type: "error", error: i })
        }
      ), k = self.setInterval(() => c == null ? void 0 : c.checkStall(), 500), u({ type: "ready" }), re(e.url);
      break;
    }
    case "event":
      m({ type: "event", event: ie(e.event) });
      break;
    case "set_fit":
      a && (e.fit && (a.fit = e.fit), e.background !== void 0 && (a.background = e.background));
      break;
    case "resize":
      b = e.cssWidth, w = e.cssHeight, v = e.backingWidth, x = e.backingHeight, S = e.pixelRatio, a == null || a.resize(e.backingWidth, e.backingHeight), c == null || c.reset(), m({
        type: "set_viewport",
        width: e.cssWidth,
        height: e.cssHeight,
        pwidth: e.backingWidth,
        pheight: e.backingHeight,
        ratio: e.pixelRatio
      }), _("viewport resized");
      break;
    case "capture":
      ae(e.id, e.format);
      break;
    case "dispose":
      k !== null && (clearInterval(k), k = null), c == null || c.close();
      try {
        h == null || h.close();
      } catch {
      }
      h = null;
      break;
  }
};
//# sourceMappingURL=entry-D4pAjNt7.js.map
`,K=typeof self<"u"&&self.Blob&&new Blob(["URL.revokeObjectURL(import.meta.url);",J],{type:"text/javascript;charset=utf-8"});function fe(e){let t;try{if(t=K&&(self.URL||self.webkitURL).createObjectURL(K),!t)throw"";const s=new Worker(t,{type:"module",name:e?.name});return s.addEventListener("error",()=>{(self.URL||self.webkitURL).revokeObjectURL(t)}),s}catch{return new Worker("data:text/javascript;charset=utf-8,"+encodeURIComponent(J),{type:"module",name:e?.name})}}function ge(){return new fe}const me={framesDisplayed:0,framesDropped:0,lastDisplayedSeq:-1,decodeQueueSize:0,transport:"none"};class be{constructor(t,s){u(this,"canvas"),u(this,"worker"),u(this,"options"),u(this,"dpr"),u(this,"backingWidth",0),u(this,"backingHeight",0),u(this,"resizeObserver"),u(this,"captureWaiters",new Map),u(this,"captureId",0),u(this,"_lastCaptureSeq",-1),u(this,"disposed",!1),u(this,"_state","connecting"),u(this,"_stats",{...me}),u(this,"log"),u(this,"onPointer",l=>{if(l.type==="pointerdown"){this.canvas.focus();try{this.canvas.setPointerCapture(l.pointerId)}catch{}}const d=this.canvas.getBoundingClientRect();this.post({type:"event",event:le(l,d)})}),u(this,"onWheel",l=>{const d=this.canvas.getBoundingClientRect();this.post({type:"event",event:de(l,d)})}),u(this,"onKey",l=>{this.post({type:"event",event:ue(l)})}),this.options=s,this.log=pe(s.debug??!1,"view"),this.log.log("init",{url:s.url,fit:s.fit,imageOnly:s.imageOnly}),this.dpr=s.devicePixelRatio??globalThis.devicePixelRatio??1,this.canvas=this.resolveCanvas(t),this.canvas.tabIndex=this.canvas.tabIndex>=0?this.canvas.tabIndex:0;const i=this.canvas.getBoundingClientRect(),n=i.width||this.canvas.clientWidth||320,r=i.height||this.canvas.clientHeight||240,o=j(n,r,this.dpr,s.maxBackingDimension);this.backingWidth=o.backingWidth,this.backingHeight=o.backingHeight,this.canvas.width=o.backingWidth,this.canvas.height=o.backingHeight;const c=this.canvas.transferControlToOffscreen();this.worker=(s.workerFactory??ge)(),this.worker.onmessage=l=>this.onWorkerMessage(l.data);const g={type:"init",canvas:c,url:s.url,devicePixelRatio:this.dpr,backingWidth:o.backingWidth,backingHeight:o.backingHeight,cssWidth:n,cssHeight:r,options:{maxInflight:s.maxInflight,imageOnly:s.imageOnly,token:s.token,fit:s.fit,background:s.background,debug:s.debug}};this.worker.postMessage(g,[c]),this.attachListeners(),s.autoResize!==!1&&this.observeResize()}get state(){return this._state}get stats(){return this._stats}get lastCaptureSeq(){return this._lastCaptureSeq}setFit(t,s){this.post({type:"set_fit",fit:t,background:s})}capture(t="imagedata"){const s=++this.captureId;return new Promise(i=>{this.captureWaiters.set(s,i),this.post({type:"capture",id:s,format:t})})}dispose(){var t;this.disposed||(this.disposed=!0,(t=this.resizeObserver)==null||t.disconnect(),this.detachListeners(),this.post({type:"dispose"}),this.worker.terminate(),this.captureWaiters.clear())}resolveCanvas(t){if(t instanceof HTMLCanvasElement)return t;const s=t.ownerDocument.createElement("canvas");return s.style.width="100%",s.style.height="100%",s.style.display="block",t.appendChild(s),s}post(t){this.disposed||this.worker.postMessage(t)}attachListeners(){this.canvas.addEventListener("pointermove",this.onPointer),this.canvas.addEventListener("pointerdown",this.onPointer),this.canvas.addEventListener("pointerup",this.onPointer),this.canvas.addEventListener("wheel",this.onWheel,{passive:!0}),this.canvas.addEventListener("keydown",this.onKey),this.canvas.addEventListener("keyup",this.onKey)}detachListeners(){this.canvas.removeEventListener("pointermove",this.onPointer),this.canvas.removeEventListener("pointerdown",this.onPointer),this.canvas.removeEventListener("pointerup",this.onPointer),this.canvas.removeEventListener("wheel",this.onWheel),this.canvas.removeEventListener("keydown",this.onKey),this.canvas.removeEventListener("keyup",this.onKey)}observeResize(){this.resizeObserver=new ResizeObserver(()=>{const t=this.canvas.getBoundingClientRect();if(t.width===0||t.height===0)return;this.dpr=this.options.devicePixelRatio??globalThis.devicePixelRatio??1;const s=j(t.width,t.height,this.dpr,this.options.maxBackingDimension);s.backingWidth===this.backingWidth&&s.backingHeight===this.backingHeight||(this.backingWidth=s.backingWidth,this.backingHeight=s.backingHeight,this.post({type:"resize",backingWidth:s.backingWidth,backingHeight:s.backingHeight,cssWidth:t.width,cssHeight:t.height,pixelRatio:s.pixelRatio}))}),this.resizeObserver.observe(this.canvas)}onWorkerMessage(t){var s,i,n,r,o,c;switch(t.type){case"state":this._state=t.state,this.log.log("state",t.state),(i=(s=this.options).onState)==null||i.call(s,t.state);break;case"stats":this._stats=t.stats,(r=(n=this.options).onStats)==null||r.call(n,t.stats);break;case"capture-result":{this._lastCaptureSeq=t.lastDisplayedSeq;const g=this.captureWaiters.get(t.id);g&&(this.captureWaiters.delete(t.id),g(t.imageData??t.blob));break}case"error":this._state="error",this.log.error("worker",t.error),(c=(o=this.options).onError)==null||c.call(o,new Error(t.error));break}}}new TextDecoder("utf-8");new TextEncoder;const ve=[{id:"vanilla",label:"Vanilla"},{id:"react",label:"React"}];async function ye(e,t,s){if(e==="react"){const[{createRoot:n},{createElement:r},{ReactViewer:o}]=await Promise.all([$(()=>import("./client.js").then(l=>l.c),__vite__mapDeps([0,1]),import.meta.url),$(()=>import("./index2.js").then(l=>l.i),__vite__mapDeps([2,1]),import.meta.url),$(()=>import("./reactViewer.js"),__vite__mapDeps([3,2,1]),import.meta.url)]);let c=null;const g=n(t);return g.render(r(o,{options:s,onReady:l=>c=l})),{framework:e,setFit:(l,d)=>c?.setFit(l,d),capture:async()=>await c.capture("blob"),dispose:()=>g.unmount()}}const i=new be(t,s);return{framework:e,setFit:(n,r)=>i.setFit(n,r),capture:async()=>await i.capture("blob"),dispose:()=>i.dispose()}}const we=["contain","cover","fill"];let z,f=[],O="default",w=null;const m={framework:"vanilla",fit:"contain",debug:new URLSearchParams(location.search).get("debug")==="1"||localStorage.getItem("rfb-debug")==="1"},P=a("div",{class:"viewport"}),T=a("div",{}),F=a("span",{class:"pill","data-tone":"connecting",text:"connecting"}),Z=a("dd",{text:"—"}),E=a("dl",{class:"stats"}),L=a("div",{class:"err-line",style:"display:none"});function k(){return f.find(e=>e.name===O)??f[0]}async function ke(){z=await h.capabilities(),f=(await h.state()).streams,xe(),await C("default"),setInterval(Ce,2500)}function xe(){const e=document.getElementById("app"),t=a("header",{class:"demo__head"},[a("h1",{class:"demo__title",html:"pdum·rfb <small>demo</small>"}),a("span",{class:"demo__tagline",text:"render in Python, view in the browser"}),a("div",{class:"demo__spacer"}),F]),s=a("div",{class:"demo__view"},[P]),i=a("div",{class:"group"},[a("div",{class:"group__title",text:"Session"}),a("dl",{class:"stats"},[a("dt",{text:"viewers"}),Z]),E,L]),n=a("aside",{class:"rail"},[T,i]);H(e),e.append(a("div",{class:"demo"},[t,s,n]))}async function D(){w?.dispose(),w=null,H(P);const e=k();w=await ye(m.framework,P,{url:ie(e.name),fit:m.fit,debug:m.debug,onState:Se,onStats:_e})}async function C(e){f.some(t=>t.name===e)||(e="default"),O=e,R(),await D()}function Se(e){F.textContent=G(e),F.setAttribute("data-tone",te(e))}function _e(e){H(E);for(const[t,s]of se("negotiated",e))t!=="state"&&E.append(a("dt",{text:t}),a("dd",{text:s}));e.recoveries&&E.append(a("dt",{text:"recoveries"}),a("dd",{text:String(e.recoveries)}))}function R(){H(T),T.append(Re(),We(),Ee(),De(),Pe())}function q(e,t,s){const i=a("select",{onchange:r=>s(r.target.value)});let n=!1;for(const r of e){const o=a("option",{value:r.value,text:r.label,disabled:r.disabled,title:r.title});r.value===t&&(o.selected=!0,n=!0),i.append(o)}if(!n){const r=a("option",{value:t,text:t,selected:!0});i.insertBefore(r,i.firstChild)}return i}function V(e,t,s){return a("div",{class:"seg"},e.map(i=>a("button",{type:"button",text:i.label,title:i.title,disabled:i.disabled,"aria-pressed":String(i.id===t),onclick:()=>s(i.id)})))}function Re(){const e=k(),t=f.map(n=>({value:n.name,label:n.name==="default"?"default · shared":`${n.name} · private`})),s=q(t,O,n=>void C(n)),i=a("div",{class:"btn-row"},[a("button",{type:"button",text:"＋ private stream",onclick:()=>void Le()})]);return e.private&&i.append(a("button",{type:"button",text:"destroy",onclick:()=>void He(e.name)})),a("div",{class:"group"},[a("div",{class:"group__title",text:"Stream"}),p("Stream",s,"Shared 'default' fans one feed to every viewer; a private stream is yours alone (own scene/backend + the structural params below)."),i])}function We(){const e=k(),t=z.scenes.map(r=>({value:r.key,label:r.available?r.name:`${r.name} — unavailable`,disabled:!r.available,title:r.available?r.description:r.reason})),s=z.backends.map(r=>({value:r.id,label:r.available?r.label:`${r.label} — n/a`,disabled:!r.available,title:r.available?"":r.reason})),i=q(t,e.scene,r=>void _(h.setScene(e.name,r)));i.dataset.testid="scene";const n=q(s,e.backend,r=>void _(h.setBackend(e.name,r)));return n.dataset.testid="backend",a("div",{class:"group"},[a("div",{class:"group__title",text:"Scene & backend"}),p("Scene",i,"What the render loop publishes. Greyed scenes need absent hardware/deps."),p("Backend",n,"Live-switched on the same socket; the browser follows on the next keyframe. Greyed backends can't run here.")])}function Ee(){const e=k(),t=a("input",{type:"text",value:e.bitrate_label}),s=a("input",{type:"number",value:String(e.fps),min:"1",max:"120"}),i=a("input",{type:"number",value:String(e.width),min:"16"}),n=a("input",{type:"number",value:String(e.height),min:"16"}),r=["srgb","display-p3"].map(o=>({value:o,label:o}));return a("div",{class:"group"},[a("div",{class:"group__title",text:"Quality"}),p("Bitrate",t,"Target H.264/NVENC bitrate, e.g. 8M or 800k. Image modes ignore it."),p("FPS",s,"Publish + encoder IDR-cadence target."),p("Apply",a("div",{class:"btn-row"},[a("button",{type:"button",class:"primary",text:"retune",onclick:()=>void _(h.setQuality(e.name,{bitrate:t.value,fps:Number(s.value)}))})])),p("Size",a("div",{class:"btn-row"},[i,a("span",{text:"×"}),n]),"Render size (even). Publishing a new size rebuilds encoders + keyframes. Under match_client the viewer drives it."),p("Color",q(r,e.color,o=>void _(h.setParams(e.name,{color:o}))),"Tag the stream color space (P3 = Apple wide-gamut SDR)."),a("div",{class:"btn-row"},[a("button",{type:"button",text:"apply size",onclick:()=>void _(h.setParams(e.name,{width:Number(i.value),height:Number(n.value)}))})])])}function De(){const e=V(ve.map(i=>({id:i.id,label:i.label})),m.framework,i=>{m.framework=i,R(),D()}),t=V(we.map(i=>({id:i,label:i})),m.fit,i=>{m.fit=i,R(),w?.setFit(m.fit)}),s=a("label",{class:"toggle"},[(()=>{const i=a("input",{type:"checkbox"});return i.dataset.testid="debug",i.checked=m.debug,i.addEventListener("change",()=>{m.debug=i.checked,localStorage.setItem("rfb-debug",i.checked?"1":"0"),D()}),i})(),a("span",{text:"console logging"})]);return a("div",{class:"group"},[a("div",{class:"group__title",text:"Viewer"}),p("Framework",e,"Which wrapper renders the viewer, live-swapped. Vanilla = the core view; React = the same view inside a React component."),p("Fit",t,"How the frame maps into the viewport when aspect ratios differ."),p("Debug",s,"Verbose client-side console logging (WS lifecycle, negotiation, keyframes, decode). Errors surface either way."),a("div",{class:"btn-row"},[a("button",{type:"button",text:"capture PNG",onclick:()=>void Oe()}),a("button",{type:"button",text:"fullscreen",onclick:()=>void P.requestFullscreen?.()}),a("button",{type:"button",text:"reconnect",onclick:()=>void D()})])])}function Pe(){const e=k(),t=[["adaptive",e.adaptive?"on":"off"],["still after",e.still_after==null?"off":`${e.still_after}s`],["stats interval",e.stats_interval==null?"off":`${e.stats_interval}s`],["pipeline depth",String(e.encode_pipeline_depth)],["resize policy",e.resize_policy]],s=a("dl",{class:"stats"});for(const[i,n]of t)s.append(a("dt",{text:i}),a("dd",{text:n}));return a("div",{class:"group"},[a("div",{class:"group__title",text:"Structural (per-stream)"}),s,a("div",{class:"note",text:"Set once at stream birth — create a private stream to explore them."})])}async function _(e){try{const t=await e;f=f.map(s=>s.name===t.name?t:s),R(),ee()}catch(t){M(String(t))}}async function Le(){const e=qe();if(e)try{const t=await h.createStream(e);f=(await h.state()).streams,await C(t.name)}catch(t){M(String(t))}}function qe(){const e=confirm("Enable adaptive quality on the new private stream? (Cancel = off)"),t=prompt("Still-after-settle seconds (blank = off):",""),s=prompt("Encoder pipeline depth (0 = synchronous):","0");return{adaptive:e,still_after:t?.trim()?Number(t):null,encode_pipeline_depth:s?.trim()?Number(s):0,stats_interval:1}}async function He(e){try{await h.deleteStream(e),f=(await h.state()).streams,await C("default")}catch(t){M(String(t))}}async function Oe(){if(!w)return;const e=await w.capture(),t=URL.createObjectURL(e);a("a",{href:t,download:`${O}.png`}).click(),setTimeout(()=>URL.revokeObjectURL(t),1e3)}function ee(){const e=k();Z.textContent=String(e.clients),e.last_error?M(e.last_error):L.style.display="none"}function M(e){L.textContent=e,L.style.display=""}async function Ce(){try{const e=(await h.state()).streams,t=e.map(s=>s.name).join()!==f.map(s=>s.name).join();f=e,ee(),t&&R()}catch{}}ke().catch(e=>{document.getElementById("app").textContent=`Failed to start demo: ${e}`});export{be as I};
