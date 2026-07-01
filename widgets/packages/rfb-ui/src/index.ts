// Framework-agnostic, pure helpers shared by the tier-2 (batteries) components in
// @habemus-papadum/rfb-{react,svelte,solid}. No DOM construction here — each framework
// renders its own idiomatic markup and consumes these formatters + the sibling rfb.css.
// This package is PRIVATE: its code is bundled into each wrapper's dist, so wrappers only
// devDepend it (never a runtime/peer dep).

import type { ConnectionState, Stats } from "@habemus-papadum/rfb-widgets";

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

/** Compact always-on badge: transport · fps · rtt (blanks omitted until the server pushes them). */
export function formatBadge(s: Stats): string {
  const label = s.transport === "webcodecs" ? "H.264" : s.transport === "image" ? "IMG" : "—";
  const parts = [label];
  if (s.serverFpsSent !== undefined) parts.push(`${s.serverFpsSent.toFixed(0)} fps`);
  if (s.serverRttMs !== undefined) parts.push(`${s.serverRttMs.toFixed(0)} ms`);
  return parts.join(" · ");
}
