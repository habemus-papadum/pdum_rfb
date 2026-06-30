# Metrics & adaptive quality

`pdum.rfb` measures every session and can adapt encoding quality to the link in real
time. This page is the **end-to-end** view — it spans the Python server and the
browser client, which is why it lives on its own rather than split across the two
guides. For the per-language API details see the
[Python guide](guide_python.md#measuring-adapting-the-encoder) and the
[JavaScript guide](guide_javascript.md).

## The loop

```text
browser                                   server (per RfbSession)
───────                                   ───────────────────────
decode a frame ── ack{seq, decode_queue_size, displayed} ──►  measure RTT (send→displayed),
   │                                                          decode-queue depth, fps, bitrate
   │                                                                 │
   │                                              AdaptiveQualityController.update()
   │                                              lowers bitrate → fps → in-flight (recovers when healthy)
   │                                                                 │
   ◄── set_quality{bitrate, fps}  (new targets) ────────────────────┤
   ◄── stats{rtt_ms, fps_sent, bitrate_bps, ...}  (server truth) ───┘   (opt-in: stats_interval)
   │
 fold both into `Stats` ──► onStats(stats) ──► your UI
```

The client is the sensor (it reports its decode-queue depth and acks every displayed
frame); the server is the controller (it measures and decides); and the two control
messages close the loop back to your UI. Nothing here is required — a plain
`serve()` streams happily without any of it — but turning it on gives you a live,
honest picture of the link and lets the encoder ride congestion down and back up.

## Server: turn it on

```python
import pdum.rfb as rfb

display = await rfb.serve(
    1280, 720,
    adaptive=True,        # react to congestion: bitrate → fps → in-flight
    stats_interval=1.0,   # push server-truth metrics to each client every 1 s
)
```

- **`adaptive=True`** enables the three-lever controller (see the
  [Python guide](guide_python.md#adaptive-quality)). It rebuilds the encoder and
  emits `set_quality` as it reacts.
- **`stats_interval=1.0`** opts into the periodic server→client `stats` message.
  Without it the browser only knows its *own* decode side; with it, it also sees the
  server's authoritative RTT, fps, bitrate, and encode time.

Server metrics are also available over HTTP for dashboards/scraping (no browser
needed):

```bash
curl http://127.0.0.1:8765/metrics                # one object per active session
curl http://127.0.0.1:8765/streams/<name>/metrics # per stream, with a hub
```

Both return the same `SessionMetrics.snapshot()` shape the `stats` push is built
from.

## Client: the `Stats` object

The view delivers a `Stats` to your `onStats` callback (and exposes the latest as
`view.stats`). Its fields split into two groups:

| Field | Source | Notes |
| ----- | ------ | ----- |
| `transport` | local | `"image" \| "webcodecs" \| "none"` |
| `framesDisplayed`, `framesDropped` | local | what the client actually drew |
| `lastDisplayedSeq` | local | newest displayed frame |
| `decodeQueueSize` | local | the congestion signal it reports back |
| `serverRttMs` | server | send→displayed round trip, server-measured |
| `serverFpsSent`, `serverBitrateBps` | server | what the server is actually emitting |
| `serverEncodeMs`, `serverDropped` | server | encode cost / server-side drops |
| `targetBitrate`, `targetFps` | server | the adaptive controller's current targets |

The `server*` / `target*` fields are **`undefined` until the server pushes them** —
i.e. only when it was started with `stats_interval` (and/or `adaptive`). Always
guard on presence.

## Showing it in the UI

`onStats` fires on every displayed frame (and on each `set_quality` / `stats`), so
it's all you need to drive a live HUD. A self-contained, framework-free example:

```ts
import { RemoteFramebufferView, type Stats } from "@habemus-papadum/rfb-widgets";

const hud = document.getElementById("hud")!;

const mbps = (bps?: number) => (bps === undefined ? "—" : `${(bps / 1e6).toFixed(1)} Mbps`);
const ms = (v?: number) => (v === undefined ? "—" : `${v.toFixed(0)} ms`);
const n = (v?: number) => (v === undefined ? "—" : v.toFixed(1));

function renderHud(s: Stats): void {
  const rows: [string, string][] = [
    ["transport", s.transport],
    ["displayed", `${s.framesDisplayed} (dropped ${s.framesDropped})`],
    ["decode queue", String(s.decodeQueueSize)],
    // server-truth — only present with serve(stats_interval=…)
    ["rtt", ms(s.serverRttMs)],
    ["server fps", n(s.serverFpsSent)],
    ["server bitrate", mbps(s.serverBitrateBps)],
    ["encode", ms(s.serverEncodeMs)],
    // adaptive targets — present with serve(adaptive=True)
    ["target bitrate", mbps(s.targetBitrate)],
    ["target fps", n(s.targetFps)],
  ];
  hud.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
}

new RemoteFramebufferView(document.getElementById("stage")!, {
  url: "ws://localhost:8765",
  onStats: renderHud,
  // optionally throttle your own redraws if you prefer a fixed cadence:
  // onStats: (s) => { latest = s; }  // then render from a setInterval / rAF
});
```

`onStats` can fire at the frame rate, so if your HUD is expensive, stash the latest
`Stats` and repaint on a timer or `requestAnimationFrame` instead of every callback.

A note on **fps numbers**: `serverFpsSent` is how fast the *server* is emitting,
which in the push model is whatever cadence your publish loop runs at (not a fixed
target). `targetFps` is the adaptive controller's current ceiling — it drops below
`serverFpsSent` only when the controller has eased the rate under congestion.

## See it live

The bundled demo renders exactly this HUD from `onStats`. Run the server with
adaptation + stats on and open the demo:

```bash
uv run python -m pdum.rfb.server --pattern bouncing_box --adaptive --stats-interval 1.0
cd widgets && pnpm dev      # http://localhost:5173
```

The HUD shows `—` for the `server*` rows until the first `stats` push arrives (~1 s),
then fills in; drop the `--stats-interval` flag and those rows stay `—` while the
local rows keep updating — a quick way to see exactly which numbers are local vs.
server-truth.
