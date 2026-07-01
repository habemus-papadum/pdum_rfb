const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./client.js","./index3.js","./index2.js","./reactViewer.js"])))=>i.map(i=>d[i]);
(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))s(n);new MutationObserver(n=>{for(const a of n)if(a.type==="childList")for(const o of a.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&s(o)}).observe(document,{childList:!0,subtree:!0});function i(n){const a={};return n.integrity&&(a.integrity=n.integrity),n.referrerPolicy&&(a.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?a.credentials="include":n.crossOrigin==="anonymous"?a.credentials="omit":a.credentials="same-origin",a}function s(n){if(n.ep)return;n.ep=!0;const a=i(n);fetch(n.href,a)}})();const F=e=>e===void 0?"—":`${(e/1e6).toFixed(1)} Mbps`,N=e=>e===void 0?"—":`${e.toFixed(0)} ms`,U=e=>e===void 0?"—":e.toFixed(1);function te(e){switch(e){case"open":case"negotiated":return"open";case"error":return"error";case"closed":return"closed";default:return"connecting"}}function G(e){return e==="negotiated"?"live":e}function ie(e,t){return[["state",G(e)],["transport",t.transport],["displayed",`${t.framesDisplayed} (dropped ${t.framesDropped})`],["decode queue",String(t.decodeQueueSize)],["rtt",N(t.serverRttMs)],["server fps",U(t.serverFpsSent)],["server bitrate",F(t.serverBitrateBps)],["encode",N(t.serverEncodeMs)],["target bitrate",F(t.targetBitrate)],["target fps",U(t.targetFps)]]}async function v(e,t,i){const s=await fetch(t,{method:e,headers:i!==void 0?{"content-type":"application/json"}:void 0,body:i!==void 0?JSON.stringify(i):void 0}),n=await s.text(),a=n?JSON.parse(n):{};if(!s.ok)throw new Error(a.error??`${s.status} ${s.statusText}`);return a}const h={capabilities:()=>v("GET","/demo/capabilities"),state:()=>v("GET","/demo/state"),createStream:e=>v("POST","/demo/streams",e),deleteStream:e=>v("DELETE",`/demo/streams/${e}`),setScene:(e,t)=>v("POST",`/demo/streams/${e}/scene`,{key:t}),setBackend:(e,t)=>v("POST",`/demo/streams/${e}/backend`,{id:t}),setQuality:(e,t)=>v("POST",`/demo/streams/${e}/quality`,t),setParams:(e,t)=>v("POST",`/demo/streams/${e}/params`,t)};function se(e){return`${location.protocol==="https:"?"wss":"ws"}://${location.host}/rfb/${e}`}function r(e,t={},i=[]){const s=document.createElement(e);for(const[n,a]of Object.entries(t))a==null||a===!1||(n==="class"?s.className=String(a):n==="text"?s.textContent=String(a):n==="html"?s.innerHTML=String(a):n.startsWith("on")&&typeof a=="function"?s.addEventListener(n.slice(2).toLowerCase(),a):n==="value"?s.value=String(a):a===!0?s.setAttribute(n,""):s.setAttribute(n,String(a)));for(const n of i)s.append(n);return s}function p(e,t,i,s=!1){const n=r("label",{text:e});return i&&n.append(r("span",{class:"help",tabindex:"0",role:"note","aria-label":i},["?",r("span",{class:"help__tip",role:"tooltip",text:i})])),r("div",{class:s?"field field--wide":"field"},[n,t])}function H(e){for(;e.firstChild;)e.removeChild(e.firstChild)}const ae="modulepreload",ne=function(e,t){return new URL(e,t).href},Q={},$=function(t,i,s){let n=Promise.resolve();if(i&&i.length>0){let o=function(l){return Promise.all(l.map(y=>Promise.resolve(y).then(x=>({status:"fulfilled",value:x}),x=>({status:"rejected",reason:x}))))};const c=document.getElementsByTagName("link"),g=document.querySelector("meta[property=csp-nonce]"),d=g?.nonce||g?.getAttribute("nonce");n=o(i.map(l=>{if(l=ne(l,s),l in Q)return;Q[l]=!0;const y=l.endsWith(".css"),x=y?'[rel="stylesheet"]':"";if(!!s)for(let S=c.length-1;S>=0;S--){const E=c[S];if(E.href===l&&(!y||E.rel==="stylesheet"))return}else if(document.querySelector(`link[href="${l}"]${x}`))return;const b=document.createElement("link");if(b.rel=y?"stylesheet":ae,y||(b.as="script"),b.crossOrigin="",b.href=l,d&&b.setAttribute("nonce",d),document.head.appendChild(b),y)return new Promise((S,E)=>{b.addEventListener("load",S),b.addEventListener("error",()=>E(new Error(`Unable to preload CSS for ${l}`)))})}))}function a(o){const c=new Event("vite:preloadError",{cancelable:!0});if(c.payload=o,window.dispatchEvent(c),!c.defaultPrevented)throw o}return n.then(o=>{for(const c of o||[])c.status==="rejected"&&a(c.reason);return t().catch(a)})};var re=Object.defineProperty,oe=(e,t,i)=>t in e?re(e,t,{enumerable:!0,configurable:!0,writable:!0,value:i}):e[t]=i,u=(e,t,i)=>oe(e,typeof t!="symbol"?t+"":t,i);function I(e){const t=[];return e.shiftKey&&t.push("Shift"),e.ctrlKey&&t.push("Control"),e.altKey&&t.push("Alt"),e.metaKey&&t.push("Meta"),t}function ce(e){switch(e){case 0:return 1;case 1:return 3;case 2:return 2;case 3:return 4;case 4:return 5;default:return 0}}function X(e){const t=[];return e&1&&t.push(1),e&2&&t.push(2),e&4&&t.push(3),e&8&&t.push(4),e&16&&t.push(5),t}function Y(e,t,i){return{x:e-i.left,y:t-i.top}}function A(e,t,i){return t===1?e*16:t===2?e*i:e}function de(e,t){const{x:i,y:s}=Y(e.clientX,e.clientY,t);return{type:e.type==="pointerdown"?"pointer_down":e.type==="pointerup"?"pointer_up":"pointer_move",x:i,y:s,button:ce(e.button),buttons:X(e.buttons),modifiers:I(e),timestamp:e.timeStamp/1e3}}function le(e,t){const{x:i,y:s}=Y(e.clientX,e.clientY,t);return{type:"wheel",x:i,y:s,dx:A(e.deltaX,e.deltaMode,t.width),dy:A(e.deltaY,e.deltaMode,t.height),buttons:X(e.buttons),modifiers:I(e),timestamp:e.timeStamp/1e3}}function ue(e){return{type:e.type==="keydown"?"key_down":"key_up",key:e.key,code:e.code,modifiers:I(e),timestamp:e.timeStamp/1e3}}function j(e,t,i,s){let n=Math.max(1,Math.round(e*i)),a=Math.max(1,Math.round(t*i)),o=i;if(s&&Math.max(n,a)>s){const c=s/Math.max(n,a);n=Math.max(1,Math.round(n*c)),a=Math.max(1,Math.round(a*c)),o=e>0?n/e:i}return{backingWidth:n,backingHeight:a,pixelRatio:o}}const he=()=>{};function pe(e,t){const i=`[rfb:${t}]`;return{enabled:e,log:e?(s,...n)=>console.debug(`${i} ${s}`,...n):he,error:(s,...n)=>console.error(`${i} ${s}`,...n)}}const J=`var R = Object.defineProperty;
var P = (t, e, i) => e in t ? R(t, e, { enumerable: !0, configurable: !0, writable: !0, value: i }) : t[e] = i;
var n = (t, e, i) => P(t, typeof e != "symbol" ? e + "" : e, i);
const Q = {
  maxInflight: 3,
  slowDownQueue: 3,
  keyframeOnDropQueue: 6
};
class O {
  constructor(e = {}) {
    n(this, "cfg");
    n(this, "queued", []);
    this.cfg = { ...Q, ...e };
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
const E = "image/jpeg", z = "image/png", A = "webcodecs/h264-annexb", L = "avc1.42E01F";
async function F(t, e = 1280, i = 720) {
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
  return !t.imageOnly && await F(L, t.width, t.height) && e.push(A), { supported: e, devicePixelRatio: t.devicePixelRatio ?? 1 };
}
const T = () => {
};
function H(t, e) {
  const i = \`[rfb:\${e}]\`;
  return {
    enabled: t,
    log: t ? (s, ...a) => console.debug(\`\${i} \${s}\`, ...a) : T,
    error: (s, ...a) => console.error(\`\${i} \${s}\`, ...a)
  };
}
const I = new TextDecoder("utf-8");
new TextEncoder();
function N(t) {
  const e = t instanceof Uint8Array ? t : new Uint8Array(t);
  if (e.byteLength < 4)
    throw new Error("buffer too small to contain a header length prefix");
  const s = new DataView(e.buffer, e.byteOffset, e.byteLength).getUint32(0, !0);
  if (e.byteLength < 4 + s)
    throw new Error(\`buffer truncated: need \${4 + s} bytes, have \${e.byteLength}\`);
  const a = JSON.parse(I.decode(e.subarray(4, 4 + s))), r = e.subarray(4 + s);
  return { header: a, payload: r };
}
function U(t, e) {
  const i = { ...t };
  return e.rtt_ms !== void 0 && (i.serverRttMs = e.rtt_ms), e.fps_sent !== void 0 && (i.serverFpsSent = e.fps_sent), e.bitrate_bps !== void 0 && (i.serverBitrateBps = e.bitrate_bps), e.encode_ms !== void 0 && (i.serverEncodeMs = e.encode_ms), e.dropped !== void 0 && (i.serverDropped = e.dropped), e.target_bitrate !== void 0 && (i.targetBitrate = e.target_bitrate), e.target_fps !== void 0 && (i.targetFps = e.target_fps), i;
}
function V(t, e) {
  const i = { ...t };
  return e.bitrate !== void 0 && (i.targetBitrate = e.bitrate), e.fps !== void 0 && (i.targetFps = e.fps), i;
}
function $(t) {
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
  const { scaleX: e, scaleY: i } = $(t), s = t.frameW * e, a = t.frameH * i, r = (t.backingW - s) / 2, f = (t.backingH - a) / 2;
  return { dx: r, dy: f, dw: s, dh: a };
}
function M(t, e, i) {
  const { dx: s, dy: a, dw: r, dh: f } = W(t), m = r > 0 ? (e - s) / r * t.frameW : 0, w = f > 0 ? (i - a) / f * t.frameH : 0, C = m >= 0 && m < t.frameW && w >= 0 && w < t.frameH;
  return { x: m, y: w, inside: C };
}
async function X(t, e, i) {
  const s = new Blob([new Uint8Array(i)], { type: e.mime }), a = await createImageBitmap(s);
  try {
    t.draw(a, a.width, a.height);
  } finally {
    a.close();
  }
}
class J {
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
    const { dx: r, dy: f, dw: m, dh: w } = W(this.viewportState());
    a.drawImage(e, r, f, m, w);
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
const Y = { enabled: !1, log: () => {
}, error: () => {
} };
class G {
  constructor(e, i, s, a, r, f = Y) {
    n(this, "decoder", null);
    n(this, "codec", "");
    n(this, "codedWidth", 0);
    n(this, "codedHeight", 0);
    this.renderer = e, this.bp = i, this.gate = s, this.onRequestKeyframe = a, this.onDisplayed = r, this.log = f;
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
        this.log.error("decode", "VideoDecoder error", i), this.gate.reset(), this.onRequestKeyframe(String(i));
      }
    }), this.log.log("decode", "configure", { codec: e.codec, w: e.width, h: e.height }), this.decoder.configure({
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
let d = null, o = null, c = null, _ = null, g = 0, y = 0, k = 0, x = 0, S = 1, v = 1, u = {}, l = H(!1, "worker"), h = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: -1,
  decodeQueueSize: 0,
  transport: "none"
};
function p(t, e = []) {
  self.postMessage(t, e);
}
function b(t) {
  d && d.readyState === WebSocket.OPEN && d.send(JSON.stringify(t));
}
function D(t) {
  l.log("keyframe", "request:", t), b({ type: "request_keyframe", reason: t });
}
function q(t, e) {
  h.framesDisplayed += 1, h.lastDisplayedSeq = t, h.decodeQueueSize = e, b({ type: "ack", seq: t, decode_queue_size: e, displayed: !0 }), p({ type: "stats", stats: { ...h } });
}
function j(t) {
  return (t && typeof t == "object" ? t.primaries : void 0) === "display-p3" ? "display-p3" : "srgb";
}
function Z(t) {
  if (t.type === "pointer_move" || t.type === "pointer_down" || t.type === "pointer_up" || t.type === "wheel") {
    const e = g > 0 ? k / g : 1, i = y > 0 ? x / y : 1, { x: s, y: a, inside: r } = M(o.viewportState(), t.x * e, t.y * i);
    return { ...t, x: s, y: a, inside: r, pixel_ratio: v };
  }
  return t;
}
function ee(t) {
  t.type === "config" ? (l.log("config", {
    transport: t.transport,
    codec: t.codec,
    pixel_ratio: t.pixel_ratio,
    color: t.color
  }), typeof t.pixel_ratio == "number" && (v = t.pixel_ratio), t.color && (o == null || o.setColorSpace(j(t.color))), p({ type: "state", state: "negotiated" })) : t.type === "set_quality" ? (h = V(h, t), p({ type: "stats", stats: { ...h } })) : t.type === "stats" && (h = U(h, t), p({ type: "stats", stats: { ...h } }));
}
async function te(t) {
  const { header: e, payload: i } = N(t), s = e.pixel_ratio;
  if (typeof s == "number" && (v = s), e.type === "image_frame") {
    const a = e;
    h.transport = "image", l.log("frame", "image", { seq: a.seq, mime: a.mime, bytes: i.byteLength });
    try {
      await X(o, a, i);
    } catch (r) {
      l.error("decode", "image decode failed", r);
      return;
    }
    q(a.seq, 0);
  } else if (e.type === "video_chunk") {
    const a = e;
    h.transport = "webcodecs", l.log("frame", "video", { seq: a.seq, keyframe: a.keyframe, bytes: i.byteLength }), c.handleChunk(a, i);
    const r = c.decodeQueueSize;
    _.shouldRequestKeyframe(r) && D("decode queue backlog");
  }
}
async function ie(t) {
  l.log("ws", "connecting", t), d = new WebSocket(t), d.binaryType = "arraybuffer", p({ type: "state", state: "connecting" }), d.onopen = async () => {
    l.log("ws", "open"), p({ type: "state", state: "open" }), c == null || c.reset();
    const e = await K({
      width: g || void 0,
      height: y || void 0,
      imageOnly: u.imageOnly
    });
    l.log("hello", { supported: e.supported, dpr: e.devicePixelRatio }), b({
      type: "hello",
      supported: e.supported,
      device_pixel_ratio: e.devicePixelRatio,
      token: u.token
      // undefined is dropped by JSON.stringify
    }), g > 0 && y > 0 && b({
      type: "set_viewport",
      width: g,
      height: y,
      pwidth: k,
      pheight: x,
      ratio: S
    });
  }, d.onmessage = (e) => {
    if (typeof e.data == "string") {
      ee(JSON.parse(e.data));
      return;
    }
    te(e.data);
  }, d.onclose = (e) => {
    l.log("ws", "closed", { code: e.code, reason: e.reason }), p({ type: "state", state: "closed" });
  }, d.onerror = () => {
    l.error("ws", "websocket error"), p({ type: "error", error: "websocket error" });
  };
}
function se(t, e) {
  const i = o, s = {
    type: "capture-result",
    id: t,
    lastDisplayedSeq: h.lastDisplayedSeq,
    width: i.canvas.width,
    height: i.canvas.height
  };
  if (e === "blob")
    i.toBlob("image/png").then((a) => p({ ...s, blob: a }));
  else {
    const a = i.readPixels();
    p({ ...s, imageData: a }, [a.data.buffer]);
  }
}
self.onmessage = (t) => {
  const e = t.data;
  switch (e.type) {
    case "init": {
      u = e.options ?? {}, l = H(!!u.debug, "worker"), l.log("init", { backing: [e.backingWidth, e.backingHeight], dpr: e.devicePixelRatio }), g = e.cssWidth, y = e.cssHeight, k = e.backingWidth, x = e.backingHeight, S = e.devicePixelRatio, o = new J(e.canvas), u.fit && (o.fit = u.fit), u.background && (o.background = u.background), o.resize(e.backingWidth, e.backingHeight), _ = new O({
        maxInflight: u.maxInflight,
        slowDownQueue: u.slowDownQueue,
        keyframeOnDropQueue: u.keyframeOnDropQueue
      }), c = new G(
        o,
        _,
        new B(),
        D,
        (i) => q(i, c.decodeQueueSize),
        l
      ), p({ type: "ready" }), ie(e.url);
      break;
    }
    case "event":
      b({ type: "event", event: Z(e.event) });
      break;
    case "set_fit":
      o && (e.fit && (o.fit = e.fit), e.background !== void 0 && (o.background = e.background));
      break;
    case "resize":
      g = e.cssWidth, y = e.cssHeight, k = e.backingWidth, x = e.backingHeight, S = e.pixelRatio, o == null || o.resize(e.backingWidth, e.backingHeight), c == null || c.reset(), b({
        type: "set_viewport",
        width: e.cssWidth,
        height: e.cssHeight,
        pwidth: e.backingWidth,
        pheight: e.backingHeight,
        ratio: e.pixelRatio
      }), D("viewport resized");
      break;
    case "capture":
      se(e.id, e.format);
      break;
    case "dispose":
      c == null || c.close();
      try {
        d == null || d.close();
      } catch {
      }
      d = null;
      break;
  }
};
//# sourceMappingURL=entry-BtnaZMNn.js.map
`,V=typeof self<"u"&&self.Blob&&new Blob(["URL.revokeObjectURL(import.meta.url);",J],{type:"text/javascript;charset=utf-8"});function fe(e){let t;try{if(t=V&&(self.URL||self.webkitURL).createObjectURL(V),!t)throw"";const i=new Worker(t,{type:"module",name:e?.name});return i.addEventListener("error",()=>{(self.URL||self.webkitURL).revokeObjectURL(t)}),i}catch{return new Worker("data:text/javascript;charset=utf-8,"+encodeURIComponent(J),{type:"module",name:e?.name})}}function ge(){return new fe}const me={framesDisplayed:0,framesDropped:0,lastDisplayedSeq:-1,decodeQueueSize:0,transport:"none"};class be{constructor(t,i){u(this,"canvas"),u(this,"worker"),u(this,"options"),u(this,"dpr"),u(this,"backingWidth",0),u(this,"backingHeight",0),u(this,"resizeObserver"),u(this,"captureWaiters",new Map),u(this,"captureId",0),u(this,"_lastCaptureSeq",-1),u(this,"disposed",!1),u(this,"_state","connecting"),u(this,"_stats",{...me}),u(this,"log"),u(this,"onPointer",d=>{if(d.type==="pointerdown"){this.canvas.focus();try{this.canvas.setPointerCapture(d.pointerId)}catch{}}const l=this.canvas.getBoundingClientRect();this.post({type:"event",event:de(d,l)})}),u(this,"onWheel",d=>{const l=this.canvas.getBoundingClientRect();this.post({type:"event",event:le(d,l)})}),u(this,"onKey",d=>{this.post({type:"event",event:ue(d)})}),this.options=i,this.log=pe(i.debug??!1,"view"),this.log.log("init",{url:i.url,fit:i.fit,imageOnly:i.imageOnly}),this.dpr=i.devicePixelRatio??globalThis.devicePixelRatio??1,this.canvas=this.resolveCanvas(t),this.canvas.tabIndex=this.canvas.tabIndex>=0?this.canvas.tabIndex:0;const s=this.canvas.getBoundingClientRect(),n=s.width||this.canvas.clientWidth||320,a=s.height||this.canvas.clientHeight||240,o=j(n,a,this.dpr,i.maxBackingDimension);this.backingWidth=o.backingWidth,this.backingHeight=o.backingHeight,this.canvas.width=o.backingWidth,this.canvas.height=o.backingHeight;const c=this.canvas.transferControlToOffscreen();this.worker=(i.workerFactory??ge)(),this.worker.onmessage=d=>this.onWorkerMessage(d.data);const g={type:"init",canvas:c,url:i.url,devicePixelRatio:this.dpr,backingWidth:o.backingWidth,backingHeight:o.backingHeight,cssWidth:n,cssHeight:a,options:{maxInflight:i.maxInflight,imageOnly:i.imageOnly,token:i.token,fit:i.fit,background:i.background,debug:i.debug}};this.worker.postMessage(g,[c]),this.attachListeners(),i.autoResize!==!1&&this.observeResize()}get state(){return this._state}get stats(){return this._stats}get lastCaptureSeq(){return this._lastCaptureSeq}setFit(t,i){this.post({type:"set_fit",fit:t,background:i})}capture(t="imagedata"){const i=++this.captureId;return new Promise(s=>{this.captureWaiters.set(i,s),this.post({type:"capture",id:i,format:t})})}dispose(){var t;this.disposed||(this.disposed=!0,(t=this.resizeObserver)==null||t.disconnect(),this.detachListeners(),this.post({type:"dispose"}),this.worker.terminate(),this.captureWaiters.clear())}resolveCanvas(t){if(t instanceof HTMLCanvasElement)return t;const i=t.ownerDocument.createElement("canvas");return i.style.width="100%",i.style.height="100%",i.style.display="block",t.appendChild(i),i}post(t){this.disposed||this.worker.postMessage(t)}attachListeners(){this.canvas.addEventListener("pointermove",this.onPointer),this.canvas.addEventListener("pointerdown",this.onPointer),this.canvas.addEventListener("pointerup",this.onPointer),this.canvas.addEventListener("wheel",this.onWheel,{passive:!0}),this.canvas.addEventListener("keydown",this.onKey),this.canvas.addEventListener("keyup",this.onKey)}detachListeners(){this.canvas.removeEventListener("pointermove",this.onPointer),this.canvas.removeEventListener("pointerdown",this.onPointer),this.canvas.removeEventListener("pointerup",this.onPointer),this.canvas.removeEventListener("wheel",this.onWheel),this.canvas.removeEventListener("keydown",this.onKey),this.canvas.removeEventListener("keyup",this.onKey)}observeResize(){this.resizeObserver=new ResizeObserver(()=>{const t=this.canvas.getBoundingClientRect();if(t.width===0||t.height===0)return;this.dpr=this.options.devicePixelRatio??globalThis.devicePixelRatio??1;const i=j(t.width,t.height,this.dpr,this.options.maxBackingDimension);i.backingWidth===this.backingWidth&&i.backingHeight===this.backingHeight||(this.backingWidth=i.backingWidth,this.backingHeight=i.backingHeight,this.post({type:"resize",backingWidth:i.backingWidth,backingHeight:i.backingHeight,cssWidth:t.width,cssHeight:t.height,pixelRatio:i.pixelRatio}))}),this.resizeObserver.observe(this.canvas)}onWorkerMessage(t){var i,s,n,a,o,c;switch(t.type){case"state":this._state=t.state,this.log.log("state",t.state),(s=(i=this.options).onState)==null||s.call(i,t.state);break;case"stats":this._stats=t.stats,(a=(n=this.options).onStats)==null||a.call(n,t.stats);break;case"capture-result":{this._lastCaptureSeq=t.lastDisplayedSeq;const g=this.captureWaiters.get(t.id);g&&(this.captureWaiters.delete(t.id),g(t.imageData??t.blob));break}case"error":this._state="error",this.log.error("worker",t.error),(c=(o=this.options).onError)==null||c.call(o,new Error(t.error));break}}}new TextDecoder("utf-8");new TextEncoder;const ve=[{id:"vanilla",label:"Vanilla"},{id:"react",label:"React"}];async function ye(e,t,i){if(e==="react"){const[{createRoot:n},{createElement:a},{ReactViewer:o}]=await Promise.all([$(()=>import("./client.js").then(d=>d.c),__vite__mapDeps([0,1]),import.meta.url),$(()=>import("./index2.js").then(d=>d.i),__vite__mapDeps([2,1]),import.meta.url),$(()=>import("./reactViewer.js"),__vite__mapDeps([3,2,1]),import.meta.url)]);let c=null;const g=n(t);return g.render(a(o,{options:i,onReady:d=>c=d})),{framework:e,setFit:(d,l)=>c?.setFit(d,l),capture:async()=>await c.capture("blob"),dispose:()=>g.unmount()}}const s=new be(t,i);return{framework:e,setFit:(n,a)=>s.setFit(n,a),capture:async()=>await s.capture("blob"),dispose:()=>s.dispose()}}const we=["contain","cover","fill"];let z,f=[],C="default",w=null;const m={framework:"vanilla",fit:"contain",debug:new URLSearchParams(location.search).get("debug")==="1"||localStorage.getItem("rfb-debug")==="1"},P=r("div",{class:"viewport"}),B=r("div",{}),T=r("span",{class:"pill","data-tone":"connecting",text:"connecting"}),Z=r("dd",{text:"—"}),W=r("dl",{class:"stats"}),D=r("div",{class:"err-line",style:"display:none"});function k(){return f.find(e=>e.name===C)??f[0]}async function ke(){z=await h.capabilities(),f=(await h.state()).streams,xe(),await q("default"),setInterval(qe,2500)}function xe(){const e=document.getElementById("app"),t=r("header",{class:"demo__head"},[r("h1",{class:"demo__title",html:"pdum·rfb <small>demo</small>"}),r("span",{class:"demo__tagline",text:"render in Python, view in the browser"}),r("div",{class:"demo__spacer"}),T]),i=r("div",{class:"demo__view"},[P]),s=r("div",{class:"group"},[r("div",{class:"group__title",text:"Session"}),r("dl",{class:"stats"},[r("dt",{text:"viewers"}),Z]),W,D]),n=r("aside",{class:"rail"},[B,s]);H(e),e.append(r("div",{class:"demo"},[t,i,n]))}async function L(){w?.dispose(),w=null,H(P);const e=k();w=await ye(m.framework,P,{url:se(e.name),fit:m.fit,debug:m.debug,onState:Se,onStats:_e})}async function q(e){f.some(t=>t.name===e)||(e="default"),C=e,R(),await L()}function Se(e){T.textContent=G(e),T.setAttribute("data-tone",te(e))}function _e(e){H(W);for(const[t,i]of ie("negotiated",e))t!=="state"&&W.append(r("dt",{text:t}),r("dd",{text:i}));e.recoveries&&W.append(r("dt",{text:"recoveries"}),r("dd",{text:String(e.recoveries)}))}function R(){H(B),B.append(Re(),Ee(),We(),Le(),Pe())}function O(e,t,i){const s=r("select",{onchange:a=>i(a.target.value)});let n=!1;for(const a of e){const o=r("option",{value:a.value,text:a.label,disabled:a.disabled,title:a.title});a.value===t&&(o.selected=!0,n=!0),s.append(o)}if(!n){const a=r("option",{value:t,text:t,selected:!0});s.insertBefore(a,s.firstChild)}return s}function K(e,t,i){return r("div",{class:"seg"},e.map(s=>r("button",{type:"button",text:s.label,title:s.title,disabled:s.disabled,"aria-pressed":String(s.id===t),onclick:()=>i(s.id)})))}function Re(){const e=k(),t=f.map(n=>({value:n.name,label:n.name==="default"?"default · shared":`${n.name} · private`})),i=O(t,C,n=>void q(n)),s=r("div",{class:"btn-row"},[r("button",{type:"button",text:"＋ private stream",onclick:()=>void De()})]);return e.private&&s.append(r("button",{type:"button",text:"destroy",onclick:()=>void He(e.name)})),r("div",{class:"group"},[r("div",{class:"group__title",text:"Stream"}),p("Stream",i,"Shared 'default' fans one feed to every viewer; a private stream is yours alone (own scene/backend + the structural params below)."),s])}function Ee(){const e=k(),t=z.scenes.map(a=>({value:a.key,label:a.available?a.name:`${a.name} — unavailable`,disabled:!a.available,title:a.available?a.description:a.reason})),i=z.backends.map(a=>({value:a.id,label:a.available?a.label:`${a.label} — n/a`,disabled:!a.available,title:a.available?"":a.reason})),s=O(t,e.scene,a=>void _(h.setScene(e.name,a)));s.dataset.testid="scene";const n=O(i,e.backend,a=>void _(h.setBackend(e.name,a)));return n.dataset.testid="backend",r("div",{class:"group"},[r("div",{class:"group__title",text:"Scene & backend"}),p("Scene",s,"What the render loop publishes. Greyed scenes need absent hardware/deps."),p("Backend",n,"Live-switched on the same socket; the browser follows on the next keyframe. Greyed backends can't run here.")])}function We(){const e=k(),t=r("input",{type:"text",value:e.bitrate_label}),i=r("input",{type:"number",value:String(e.fps),min:"1",max:"120"}),s=r("input",{type:"number",value:String(e.width),min:"16"}),n=r("input",{type:"number",value:String(e.height),min:"16"}),a=["srgb","display-p3"].map(o=>({value:o,label:o}));return r("div",{class:"group"},[r("div",{class:"group__title",text:"Quality"}),p("Bitrate",t,"Target H.264/NVENC bitrate, e.g. 8M or 800k. Image modes ignore it."),p("FPS",i,"Publish + encoder IDR-cadence target."),p("Apply",r("div",{class:"btn-row"},[r("button",{type:"button",class:"primary",text:"retune",onclick:()=>void _(h.setQuality(e.name,{bitrate:t.value,fps:Number(i.value)}))})])),p("Size",r("div",{class:"btn-row"},[s,r("span",{text:"×"}),n]),"Render size (even). Publishing a new size rebuilds encoders + keyframes. Under match_client the viewer drives it."),p("Color",O(a,e.color,o=>void _(h.setParams(e.name,{color:o}))),"Tag the stream color space (P3 = Apple wide-gamut SDR)."),r("div",{class:"btn-row"},[r("button",{type:"button",text:"apply size",onclick:()=>void _(h.setParams(e.name,{width:Number(s.value),height:Number(n.value)}))})])])}function Le(){const e=K(ve.map(s=>({id:s.id,label:s.label})),m.framework,s=>{m.framework=s,R(),L()}),t=K(we.map(s=>({id:s,label:s})),m.fit,s=>{m.fit=s,R(),w?.setFit(m.fit)}),i=r("label",{class:"toggle"},[(()=>{const s=r("input",{type:"checkbox"});return s.dataset.testid="debug",s.checked=m.debug,s.addEventListener("change",()=>{m.debug=s.checked,localStorage.setItem("rfb-debug",s.checked?"1":"0"),L()}),s})(),r("span",{text:"console logging"})]);return r("div",{class:"group"},[r("div",{class:"group__title",text:"Viewer"}),p("Framework",e,"Which wrapper renders the viewer, live-swapped. Vanilla = the core view; React = the same view inside a React component."),p("Fit",t,"How the frame maps into the viewport when aspect ratios differ."),p("Debug",i,"Verbose client-side console logging (WS lifecycle, negotiation, keyframes, decode). Errors surface either way."),r("div",{class:"btn-row"},[r("button",{type:"button",text:"capture PNG",onclick:()=>void Ce()}),r("button",{type:"button",text:"fullscreen",onclick:()=>void P.requestFullscreen?.()}),r("button",{type:"button",text:"reconnect",onclick:()=>void L()})])])}function Pe(){const e=k(),t=[["adaptive",e.adaptive?"on":"off"],["still after",e.still_after==null?"off":`${e.still_after}s`],["stats interval",e.stats_interval==null?"off":`${e.stats_interval}s`],["pipeline depth",String(e.encode_pipeline_depth)],["resize policy",e.resize_policy]],i=r("dl",{class:"stats"});for(const[s,n]of t)i.append(r("dt",{text:s}),r("dd",{text:n}));return r("div",{class:"group"},[r("div",{class:"group__title",text:"Structural (per-stream)"}),i,r("div",{class:"note",text:"Set once at stream birth — create a private stream to explore them."})])}async function _(e){try{const t=await e;f=f.map(i=>i.name===t.name?t:i),R(),ee()}catch(t){M(String(t))}}async function De(){const e=Oe();if(e)try{const t=await h.createStream(e);f=(await h.state()).streams,await q(t.name)}catch(t){M(String(t))}}function Oe(){const e=confirm("Enable adaptive quality on the new private stream? (Cancel = off)"),t=prompt("Still-after-settle seconds (blank = off):",""),i=prompt("Encoder pipeline depth (0 = synchronous):","0");return{adaptive:e,still_after:t?.trim()?Number(t):null,encode_pipeline_depth:i?.trim()?Number(i):0,stats_interval:1}}async function He(e){try{await h.deleteStream(e),f=(await h.state()).streams,await q("default")}catch(t){M(String(t))}}async function Ce(){if(!w)return;const e=await w.capture(),t=URL.createObjectURL(e);r("a",{href:t,download:`${C}.png`}).click(),setTimeout(()=>URL.revokeObjectURL(t),1e3)}function ee(){const e=k();Z.textContent=String(e.clients),e.last_error?M(e.last_error):D.style.display="none"}function M(e){D.textContent=e,D.style.display=""}async function qe(){try{const e=(await h.state()).streams,t=e.map(i=>i.name).join()!==f.map(i=>i.name).join();f=e,ee(),t&&R()}catch{}}ke().catch(e=>{document.getElementById("app").textContent=`Failed to start demo: ${e}`});export{be as Q};
