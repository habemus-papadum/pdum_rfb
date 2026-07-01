# JavaScript Guide

The browser client is a single framework-agnostic class, `RemoteFramebufferView`.
All decoding runs in a **Web Worker** that owns the WebSocket, the decoder, and a
transferred `OffscreenCanvas`, so the main thread stays free for your UI.

> The client lives in `widgets/` and publishes as `@habemus-papadum/rfb-widgets`. During
> development, import from the source (`../src/index`); when consumed as a package,
> import from `@habemus-papadum/rfb-widgets`.

## Quick start

```ts
import { RemoteFramebufferView } from "@habemus-papadum/rfb-widgets";

const view = new RemoteFramebufferView(document.getElementById("stage")!, {
  url: "ws://localhost:8765",
  onState: (s) => console.log("state:", s),
  onStats: (s) => console.log(s.transport, s.framesDisplayed, "fps-ish"),
});

// when you're done (route change, component unmount, ...):
view.dispose();
```

Pass either a `<canvas>` (used directly) or any container element (a canvas is
created to fill it). The view sizes the canvas backing store, transfers it to the
worker, opens the connection, and starts forwarding input events.

## Options

```ts
interface RfbViewOptions {
  url: string;                       // ws:// or wss:// endpoint
  workerFactory?: () => Worker;      // override worker construction (see CSP below)
  autoResize?: boolean;              // default true (ResizeObserver -> set_viewport)
  devicePixelRatio?: number;         // override window.devicePixelRatio
  maxBackingDimension?: number;      // cap backing pixels (decoder/GPU limits)
  imageOnly?: boolean;               // force the image transport (skip H.264)
  maxInflight?: number;              // client-side decode backpressure ceiling
  fit?: "contain" | "cover" | "fill"; // frame-vs-canvas AR handling (default "contain")
  background?: string;               // letterbox fill for "contain" (CSS color; default "#000")
  token?: string;                    // auth credential sent in `hello` (e.g. a Google ID token)
  onState?: (s: ConnectionState) => void;
  onStats?: (s: Stats) => void;
  onError?: (e: Error) => void;
}
```

**Fit modes.** When the stream's aspect ratio differs from the canvas, `fit` decides:
`"contain"` (default) letterboxes with `background`, `"cover"` crops, `"fill"` stretches
each axis (the pre-fit-modes behavior). Change it live with `view.setFit(fit, background?)`.
The client owns a single frame↔canvas transform (`viewport.ts`), so it maps every
pointer/wheel event to **framebuffer pixels** through the current fit before sending — the
publisher receives coordinates that index its frame directly, correct under any fit / DPR
(see [Input events](#input-events)). Wide-gamut streams (the server tagged
`color=DISPLAY_P3`) render on a matching `display-p3` canvas automatically.

`ConnectionState` is `connecting | open | negotiated | closed | error`. `Stats`
reports the local decode side — `framesDisplayed`, `framesDropped`,
`lastDisplayedSeq`, `decodeQueueSize`, and `transport` (`image | webcodecs | none`).
When the server is started with `stats_interval` (and/or `adaptive`), it also pushes
authoritative server-truth metrics that `Stats` surfaces as optional fields:
`serverRttMs`, `serverFpsSent`, `serverBitrateBps`, `serverEncodeMs`,
`serverDropped`, and the adaptive `targetBitrate` / `targetFps` (undefined until the
server sends them). For the full loop and a worked stats-HUD example, see
[Metrics & adaptive quality](metrics_adaptive.md).

### Authentication

Pass `token` (e.g. a Google OAuth ID token your page already obtained) and it is
sent in the `hello` message; the server's `authenticate` hook verifies it before
streaming and closes the socket with code `4401` if it's rejected (see the
[Python guide](guide_python.md#authentication)). Resolve the token before
constructing the view; for short-lived tokens you currently reconnect with a fresh
one (there is no built-in refresh/reconnect yet).

Methods/getters: `view.state`, `view.stats`, `view.lastCaptureSeq`,
`view.capture("imagedata" | "blob")` (a debug/test hook that reads back the
current canvas pixels), and `view.dispose()`.

## Framework integration

The core (`@habemus-papadum/rfb-widgets`) has no framework dependency, and there are thin
idiomatic wrappers for the big three. Each ships **two tiers**:

- **Tier 1 — headless.** A hook / action / primitive that owns the view lifecycle and
  exposes reactive `state` / `stats` / `error` + `capture` / `reconnect`. No markup, no
  CSS — you render and style everything.
- **Tier 2 — batteries.** A `<RemoteFramebuffer>` component with a status pill, a compact
  latency badge, a toggleable stats HUD, an error banner, and a toolbar
  (screenshot / fullscreen / transport toggle / HUD toggle). Opt-in stylesheet, fully
  themeable (see [Theming](#theming-the-batteries-component)).

| Framework | Package | Tier 1 | Tier 2 |
| --- | --- | --- | --- |
| React (≥18) | `@habemus-papadum/rfb-react` | `useRemoteFramebuffer` / `useRemoteFramebufferStats` | `<RemoteFramebuffer>` |
| Svelte (5) | `@habemus-papadum/rfb-svelte` | `createRemoteFramebuffer` (`use:` action + stores) | `<RemoteFramebuffer>` |
| Solid (≥1.8) | `@habemus-papadum/rfb-solid` | `createRemoteFramebuffer` (ref + signals) | `<RemoteFramebuffer>` |

Each wrapper peer-depends the core, so you install both (e.g.
`pnpm add @habemus-papadum/rfb-react @habemus-papadum/rfb-widgets react react-dom`). The
Web Worker is inlined in the core, so no extra bundler config is needed.

> **Recreate-on-change:** the core has no setters, so changing a connect-critical option
> (`url`, `token`, `imageOnly`, dpr, `maxBackingDimension`, `maxInflight`, `autoResize`)
> disposes and rebuilds the connection — the remote stream genuinely restarts. Cosmetic
> props and fresh callback closures do **not** recreate it.

### React

```tsx
import { RemoteFramebuffer, useRemoteFramebuffer, useRemoteFramebufferStats } from "@habemus-papadum/rfb-react";
import "@habemus-papadum/rfb-react/styles.css"; // only needed for the batteries component

// Batteries:
<RemoteFramebuffer url="ws://localhost:8765" style={{ width: 640, height: 480 }} />;

// Headless: build your own UI on the hook.
function MyView({ url }: { url: string }) {
  const { containerRef, state, view } = useRemoteFramebuffer({ url });
  const stats = useRemoteFramebufferStats(view); // opt-in; no re-render storm at frame rate
  return (
    <div style={{ width: 640, height: 480 }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <span>{state} · {stats.transport}</span>
    </div>
  );
}
```

### Svelte

```svelte
<script lang="ts">
  import { RemoteFramebuffer, createRemoteFramebuffer } from "@habemus-papadum/rfb-svelte";
  import "@habemus-papadum/rfb-svelte/styles.css";

  // Headless: `use:` action + stores.
  const fb = createRemoteFramebuffer({ url: "ws://localhost:8765" });
  const { state, stats } = fb;
</script>

<!-- Batteries -->
<RemoteFramebuffer url="ws://localhost:8765" style="width:640px;height:480px" />

<!-- Headless -->
<div class="viewport" use:fb.action={{ url: "ws://localhost:8765" }}></div>
<p>{$state} · {$stats.transport}</p>
```

### Solid

```tsx
import { RemoteFramebuffer, createRemoteFramebuffer } from "@habemus-papadum/rfb-solid";
import "@habemus-papadum/rfb-solid/styles.css";

// Batteries:
<RemoteFramebuffer url="ws://localhost:8765" style={{ width: "640px", height: "480px" }} />;

// Headless: ref + signals (pass an accessor for reactive connect params).
function MyView(props: { url: string }) {
  const fb = createRemoteFramebuffer(() => ({ url: props.url }));
  return (
    <div style={{ width: "640px", height: "480px" }}>
      <div ref={fb.ref} style={{ width: "100%", height: "100%" }} />
      <span>{fb.state()} · {fb.stats().transport}</span>
    </div>
  );
}
```

### Theming the batteries component

Tier 1 ships **no CSS**. Tier 2's stylesheet is opt-in and restyleable three ways, without
forking:

1. **CSS custom properties** on `.rfb-root` — `--rfb-accent`, `--rfb-bg`, `--rfb-fg`,
   `--rfb-overlay-bg`, `--rfb-status-{connecting,open,closed,error}`, `--rfb-radius`,
   `--rfb-font`, … Override on any ancestor to reskin.
2. **Stable part classes** — `.rfb-root[data-state]`, `.rfb-viewport`, `.rfb-toolbar`,
   `.rfb-button`, `.rfb-status`, `.rfb-badge`, `.rfb-hud`, `.rfb-banner` — for precise CSS.
3. **Structural replacement** — React/Solid `renderStatus` / `renderToolbar` / `renderHud`
   / `renderError` render-props (each given the reactive chrome context) and `children`;
   Svelte named slots. Drop regions entirely with `toolbar={false}` / `hud={false}` /
   `status={false}` / `badge={false}`.

### Other frameworks / vanilla

The core class works anywhere — instantiate in a mount hook, `dispose()` on cleanup:

```ts
import { RemoteFramebufferView } from "@habemus-papadum/rfb-widgets";
const view = new RemoteFramebufferView(el, { url: "ws://localhost:8765" });
// … later …
view.dispose();
```

For example, in Vue: `onMounted(() => (view = new RemoteFramebufferView(el.value!, { url })))`
and `onBeforeUnmount(() => view?.dispose())`.

## Input events

The view captures DOM events on the canvas and forwards normalized versions to the
server, following the [renderview spec](https://github.com/pygfx/renderview) — the
event vocabulary shared by jupyter_rfb / pygfx / fastplotlib — so events feed those
consumers without translation. It forwards `pointermove/down/up`, `wheel`, and
`keydown/keyup`, and:

- sends pointer/wheel `x`/`y` as **physical framebuffer pixels** (top-left origin):
  the worker maps CSS → backing → frame through the current fit (`viewport.ts`), so the
  publisher receives coordinates that index its frame directly — correct under any fit
  mode or DPR. It also adds `inside` (false in letterbox padding / a `cover` crop) and
  `pixel_ratio` (the frame's render DPR echo), so a publisher rendering in logical
  coordinates can divide it out;
- reports `button` as renderview's `0=none, 1=left, 2=right, 3=middle` and `buttons`
  as the **tuple** of currently-pressed buttons (not a DOM bitmask);
- capitalizes modifiers: `"Shift"`, `"Control"`, `"Alt"`, `"Meta"`;
- keeps a `code` (physical-key) field on key events — an additive extra over
  renderview — and a `timestamp` (seconds) on every input event;
- normalizes `wheel` `deltaMode` (line/page) to pixels;
- sets `tabindex` on the canvas so it can receive keyboard focus, and uses
  `setPointerCapture` so drags that leave the canvas keep reporting;
- observes resize (and DPR changes) and sends `set_viewport` (logical `width`/
  `height`, physical `pwidth`/`pheight`, `ratio`), after which the worker resizes
  the `OffscreenCanvas` and requests a fresh keyframe.

The server receives the common event vocabulary (`{type, x, y, button, buttons,
modifiers, timestamp}`, etc.); you drain it (tagged with `client_id`/`principal`)
from `display.poll_events()` in your own loop (see the [Python guide](guide_python.md)).

## Transport selection

The worker probes WebCodecs (`VideoDecoder.isConfigSupported`) and advertises
`webcodecs/h264-annexb` only when `avc1` decode is actually supported; otherwise it
advertises image formats only. The server then picks H.264 or the image path.
Force the image path with `imageOnly: true` (useful for debugging or environments
without H.264 decode).

## Worker packaging & CSP

By default the worker is **inlined** into the published bundle (Vite
`?worker&inline`), so `RemoteFramebufferView` works with any bundler — or none —
with zero worker configuration. The cost is that it constructs the worker from a
`blob:` URL, which requires the CSP directive `worker-src blob:`.

For strict-CSP sites that disallow `blob:` workers, supply your own `workerFactory`
that constructs the worker from a real, cacheable asset:

```ts
new RemoteFramebufferView(el, {
  url,
  workerFactory: () =>
    new Worker(new URL("./my-rfb-worker.ts", import.meta.url), { type: "module" }),
});
```

(The `new URL(..., import.meta.url)` form is statically detected by Vite,
webpack 5, Rollup, esbuild, and Parcel.)

> The published package currently ships **only** the self-contained inlined bundle
> (`dist/index.js`); it does not yet expose a standalone `worker` entry point. To
> build a non-`blob:` worker today, copy `src/worker/entry.ts` from this repo into
> your app and point `workerFactory` at it. A packaged worker subpath export is on
> the [roadmap](roadmap.md).

## Advanced: protocol & helpers

The package also exports the lower-level pieces for custom integrations:
`unpackBinaryMessage` / `packBinaryMessage`, `probeCapabilities` /
`isCodecSupported`, `BackpressureController` / `KeyframeGate`, the event
normalizers (`normalizePointerEvent`, `pointerToCanvas`, `mapButton`/`mapButtons`,
`computeBackingSize`, …), and all the wire/event TypeScript types. See
[Internals](internals.md) for the
wire format and worker design.

## Building & developing

```bash
pnpm install
pnpm dev          # demo at http://localhost:5173 (?ws=...&transport=image|video)
pnpm typecheck    # tsc for library + worker (separate DOM / WebWorker libs)
pnpm test         # Vitest unit tests
pnpm build        # dist/index.js (+ .d.ts), worker inlined
pnpm e2e          # Playwright headless e2e (boots the Python server + demo)
```
