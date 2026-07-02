// On-canvas stats overlay for the demo. An absolutely-positioned, dark-transparent monospace
// panel pinned to the bottom-left of the viewport container, legible over any rendered image.
// It shows live transport / fps / rtt / measured-bitrate / encode / dropped / queue numbers plus
// tiny inline-SVG sparklines (rolling history) for fps, bitrate, and rtt. Zero dependencies —
// the SVG is hand-built from a ring buffer. `pointer-events: none` so it never blocks the canvas.

import { mbps, msFmt, n1 } from "@habemus-papadum/rfb-ui";
import type { Stats } from "@habemus-papadum/rfb-widgets";
import { clear, el } from "./dom";

const HISTORY = 60; // samples kept per metric (~1 min at the demo's 1s stats cadence)
const SPARK_W = 96;
const SPARK_H = 18;

export interface StatsOverlay {
  /** The overlay root — mount this over the viewport (on a parent that survives remounts). */
  el: HTMLElement;
  update(stats: Stats): void;
  toggle(): void;
  setVisible(visible: boolean): void;
  visible(): boolean;
}

/** A fixed-capacity ring buffer of numbers (drops the oldest past `cap`). */
function ring(cap: number) {
  const buf: number[] = [];
  return {
    push(v: number) {
      if (!Number.isFinite(v)) return;
      buf.push(v);
      if (buf.length > cap) buf.shift();
    },
    get values() {
      return buf;
    },
  };
}

/** Build an auto-scaled `<polyline>` sparkline SVG for `vals` (min..max mapped to the box). */
function sparkline(vals: number[], stroke: string): string {
  const w = SPARK_W;
  const h = SPARK_H;
  const pad = 2; // keep the stroke off the top/bottom edges
  const box = `<svg class="stats-overlay__spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`;
  if (vals.length === 0) return `${box}</svg>`;
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1; // flat series → draw a centered line
  const n = vals.length;
  const yFor = (v: number) => h - pad - ((v - min) / range) * (h - 2 * pad);
  const points =
    n === 1
      ? `0,${yFor(vals[0])} ${w},${yFor(vals[0])}` // single sample → flat line across
      : vals.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${yFor(v).toFixed(1)}`).join(" ");
  return `${box}<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

const SPARK_STROKE = "#8fd6c8"; // soft teal — visible on the dark backing
const SPARK_STROKE_ALT = "#e6c98f"; // warm accent for a little variety

/** Locally-measured displayed fps, from `framesDisplayed` deltas over wall-clock — a fallback
 *  for when the server hasn't pushed `serverFpsSent` yet. */
function makeLocalFps() {
  let lastFrames: number | null = null;
  let lastT = 0;
  let ema = NaN;
  return (framesDisplayed: number): number => {
    const now = performance.now();
    if (lastFrames !== null) {
      const dt = (now - lastT) / 1000;
      const df = framesDisplayed - lastFrames;
      if (dt > 0.05 && df >= 0) {
        const inst = df / dt;
        ema = Number.isNaN(ema) ? inst : ema * 0.6 + inst * 0.4;
      }
    }
    lastFrames = framesDisplayed;
    lastT = now;
    return ema;
  };
}

export function createStatsOverlay(): StatsOverlay {
  const fpsHist = ring(HISTORY);
  const bitrateHist = ring(HISTORY);
  const rttHist = ring(HISTORY);
  const localFps = makeLocalFps();

  const meta = el("div", { class: "stats-overlay__grid stats-overlay__meta" });
  const grid = el("div", { class: "stats-overlay__grid" });
  const sparks = el("div", { class: "stats-overlay__sparks" });
  const root = el("div", { class: "stats-overlay", "aria-hidden": "true" }, [
    // "server" = the format the server declares it's sending (codec/color/size); "stats" = the
    // measured live metrics + sparklines below.
    el("div", { class: "stats-overlay__title", text: "server" }),
    meta,
    el("div", { class: "stats-overlay__title", text: "stats" }),
    grid,
    sparks,
  ]);

  let isVisible = true;

  function pair(target: HTMLElement, label: string, value: string): void {
    target.append(el("span", { class: "stats-overlay__k", text: label }), el("span", { class: "stats-overlay__v", text: value }));
  }
  const row = (label: string, value: string): void => pair(grid, label, value);

  function sparkRow(label: string, current: string, vals: number[], stroke: string): void {
    sparks.append(
      el("div", { class: "stats-overlay__sparkrow" }, [
        el("span", { class: "stats-overlay__k", text: label }),
        el("span", { class: "stats-overlay__sparksvg", html: sparkline(vals, stroke) }),
        el("span", { class: "stats-overlay__v", text: current }),
      ]),
    );
  }

  function update(stats: Stats): void {
    // Prefer the server's measured fps; fall back to a locally-computed displayed fps.
    const local = localFps(stats.framesDisplayed);
    const fps = stats.serverFpsSent ?? (Number.isNaN(local) ? undefined : local);
    if (fps !== undefined) fpsHist.push(fps);
    if (stats.serverBitrateBps !== undefined) bitrateHist.push(stats.serverBitrateBps);
    if (stats.serverRttMs !== undefined) rttHist.push(stats.serverRttMs);

    if (!isVisible) return; // keep the ring buffers warm, but skip the DOM churn while hidden

    // Server-declared metadata — what the server says it's sending (from the `config`/headers).
    clear(meta);
    pair(meta, "codec", stats.codec ?? (stats.transport === "image" ? "image" : "—"));
    pair(meta, "color", stats.colorSpace ?? "—");
    pair(meta, "size", stats.frameWidth && stats.frameHeight ? `${stats.frameWidth}×${stats.frameHeight}` : "—");
    pair(meta, "dpr", stats.renderPixelRatio !== undefined ? n1(stats.renderPixelRatio) : "—");

    clear(grid);
    row("transport", stats.transport === "webcodecs" ? "H.264" : stats.transport === "image" ? "image" : "—");
    row("fps", n1(fps));
    row("rtt", msFmt(stats.serverRttMs));
    row("bitrate", mbps(stats.serverBitrateBps));
    row("encode", msFmt(stats.serverEncodeMs));
    row("dropped", String(stats.framesDropped + (stats.serverDropped ?? 0)));
    row("queue", String(stats.decodeQueueSize));

    clear(sparks);
    sparkRow("fps", n1(fps), fpsHist.values, SPARK_STROKE);
    sparkRow("bps", mbps(stats.serverBitrateBps), bitrateHist.values, SPARK_STROKE_ALT);
    sparkRow("rtt", msFmt(stats.serverRttMs), rttHist.values, SPARK_STROKE);
  }

  function setVisible(v: boolean): void {
    isVisible = v;
    root.style.display = v ? "" : "none";
  }

  return {
    el: root,
    update,
    toggle: () => setVisible(!isVisible),
    setVisible,
    visible: () => isVisible,
  };
}
