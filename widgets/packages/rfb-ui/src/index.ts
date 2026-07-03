// Framework-agnostic, pure helpers shared by the tier-2 (batteries) components in
// @habemus-papadum/rfb-{react,svelte,solid}. No DOM construction here — each framework
// renders its own idiomatic markup and consumes these formatters + the sibling rfb.css.
// This package is PRIVATE: its code is bundled into each wrapper's dist, so wrappers only
// devDepend it (never a runtime/peer dep).

import type { ConnectionState, Stats, SurfacePreference } from "@habemus-papadum/rfb-widgets";

export type StatTone = "connecting" | "open" | "closed" | "error";
export type StatRow = readonly [label: string, value: string];

/** Neutral snapshot used before the first frame / while no view is attached. */
export const EMPTY_STATS: Stats = {
  framesDisplayed: 0,
  framesDropped: 0,
  lastDisplayedSeq: 0,
  decodeQueueSize: 0,
  transport: "none",
};

export const mbps = (bps?: number): string => (bps === undefined ? "—" : `${(bps / 1e6).toFixed(1)} Mbps`);
export const msFmt = (v?: number): string => (v === undefined ? "—" : `${v.toFixed(0)} ms`);
export const n1 = (v?: number): string => (v === undefined ? "—" : v.toFixed(1));

/** Collapse the 5 connection states to a 4-tone palette (drives `data-state` styling). */
export function statusTone(state: ConnectionState): StatTone {
  switch (state) {
    case "open":
    case "negotiated":
      return "open";
    case "error":
      return "error";
    case "closed":
      return "closed";
    default:
      return "connecting";
  }
}

/** Human label for a status pill ("negotiated" reads as "live"). */
export function statusLabel(state: ConnectionState): string {
  return state === "negotiated" ? "live" : state;
}

/** Full HUD rows — ports `widgets/demo/main.ts` `renderHud` so both stay in sync. */
export function formatStatsRows(state: ConnectionState, s: Stats): StatRow[] {
  return [
    ["state", statusLabel(state)],
    ["transport", s.transport],
    ["displayed", `${s.framesDisplayed} (dropped ${s.framesDropped})`],
    ["decode queue", String(s.decodeQueueSize)],
    ["rtt", msFmt(s.serverRttMs)],
    ["server fps", n1(s.serverFpsSent)],
    ["server bitrate", mbps(s.serverBitrateBps)],
    ["encode", msFmt(s.serverEncodeMs)],
    ["target bitrate", mbps(s.targetBitrate)],
    ["target fps", n1(s.targetFps)],
  ];
}

// --- viewport / backend controls (batteries tier) --------------------------

/** The display-backend choices offered by the batteries backend-switch control. A canvas's
 *  context type is immutable, so picking one TEARS DOWN and REBUILDS the view (reconnecting
 *  the stream) via `RemoteFramebufferView.setSurface` — this list is the menu, the caveat
 *  is documented in `docs/guide_javascript.md`. */
export const SURFACE_CHOICES: readonly { value: SurfacePreference; label: string; title: string }[] = [
  { value: "2d", label: "2D", title: "Canvas2D — the always-available floor" },
  { value: "webgl", label: "WebGL", title: "WebGL2 GPU draw path" },
  { value: "webgpu", label: "WebGPU", title: "WebGPU GPU draw path (where an adapter exists)" },
  { value: "auto", label: "Auto", title: "Prefer the GPU tiers, fall back to Canvas2D" },
];

/** The multiplicative step a single zoom-in / zoom-out click applies. */
export const ZOOM_STEP = 1.25;

/** Render a zoom multiplier as a percentage label (e.g. 1.5 -> "150%"). */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

// --- recording (batteries tier) --------------------------------------------

/** Filename (with the right extension) for a saved client-side recording, derived from the
 *  MediaRecorder's negotiated MIME type (mp4 for Safari, else webm). */
export function recordingFilename(mimeType?: string, base = "framebuffer"): string {
  const ext = mimeType && /mp4/i.test(mimeType) ? "mp4" : "webm";
  return `${base}.${ext}`;
}

/** Title/tooltip for the batteries record toggle, given the current capability + state. */
export function recordTitle(canRecord: boolean, isRecording: boolean): string {
  if (!canRecord) return "Recording needs the main-thread present path (this view's canvas is in the worker)";
  return isRecording ? "Stop recording" : "Record what you see (video)";
}

/** Glyph for the record toggle: ⏺ idle, ⏹ while recording. */
export function recordGlyph(isRecording: boolean): string {
  return isRecording ? "⏹" : "⏺";
}

/** Compact always-on badge: transport · fps · rtt (blanks omitted until the server pushes them). */
export function formatBadge(s: Stats): string {
  const label = s.transport === "webcodecs" ? "H.264" : s.transport === "image" ? "IMG" : "—";
  const parts = [label];
  if (s.serverFpsSent !== undefined) parts.push(`${s.serverFpsSent.toFixed(0)} fps`);
  if (s.serverRttMs !== undefined) parts.push(`${s.serverRttMs.toFixed(0)} ms`);
  return parts.join(" · ");
}
