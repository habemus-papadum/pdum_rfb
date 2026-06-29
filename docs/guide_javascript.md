# JavaScript Guide

The browser client is a single framework-agnostic class, `RemoteFramebufferView`.
All decoding runs in a **Web Worker** that owns the WebSocket, the decoder, and a
transferred `OffscreenCanvas`, so the main thread stays free for your UI.

> The client lives in `widgets/` and publishes as `pdum-rfb-widgets`. During
> development, import from the source (`../src/index`); when consumed as a package,
> import from `pdum-rfb-widgets`.

## Quick start

```ts
import { RemoteFramebufferView } from "pdum-rfb-widgets";

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
  onState?: (s: ConnectionState) => void;
  onStats?: (s: Stats) => void;
  onError?: (e: Error) => void;
}
```

`ConnectionState` is `connecting | open | negotiated | closed | error`. `Stats`
reports `framesDisplayed`, `framesDropped`, `lastDisplayedSeq`, `decodeQueueSize`,
and `transport` (`image | webcodecs | none`).

Methods/getters: `view.state`, `view.stats`, `view.lastCaptureSeq`,
`view.capture("imagedata" | "blob")` (a debug/test hook that reads back the
current canvas pixels), and `view.dispose()`.

## Framework integration

The core has no framework dependency — instantiate in a mount hook, dispose on
cleanup.

### React

```tsx
import { useEffect, useRef } from "react";
import { RemoteFramebufferView } from "pdum-rfb-widgets";

export function Framebuffer({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new RemoteFramebufferView(ref.current!, { url });
    return () => view.dispose();
  }, [url]);
  return <div ref={ref} style={{ width: 640, height: 480 }} />;
}
```

### Vue

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { RemoteFramebufferView } from "pdum-rfb-widgets";

const el = ref<HTMLElement>();
let view: RemoteFramebufferView | undefined;
onMounted(() => { view = new RemoteFramebufferView(el.value!, { url: "ws://localhost:8765" }); });
onBeforeUnmount(() => view?.dispose());
</script>

<template><div ref="el" style="width:640px;height:480px" /></template>
```

### Svelte / vanilla

```svelte
<script>
  import { onMount } from "svelte";
  import { RemoteFramebufferView } from "pdum-rfb-widgets";
  let el;
  onMount(() => {
    const view = new RemoteFramebufferView(el, { url: "ws://localhost:8765" });
    return () => view.dispose();
  });
</script>
<div bind:this={el} style="width:640px;height:480px"></div>
```

## Input events

The view captures DOM events on the canvas and forwards normalized versions to the
server: `pointermove/down/up`, `wheel`, and `keydown/keyup`. It:

- maps coordinates to **framebuffer pixels** (CSS coords × the effective
  backing/CSS ratio), so the server receives 1:1 coordinates;
- normalizes `wheel` `deltaMode` (line/page) to pixels;
- sets `tabindex` on the canvas so it can receive keyboard focus, and uses
  `setPointerCapture` so drags that leave the canvas keep reporting;
- observes resize (and DPR changes) and sends `set_viewport`, after which the
  worker resizes the `OffscreenCanvas` and requests a fresh keyframe.

The server receives the common event vocabulary (`{type, x, y, buttons,
modifiers}`, etc.) and routes it to your `FrameSource.handle_event`.

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

For strict-CSP sites that disallow `blob:` workers, supply your own worker built as
a real, cacheable asset:

```ts
new RemoteFramebufferView(el, {
  url,
  workerFactory: () =>
    new Worker(new URL("pdum-rfb-widgets/worker", import.meta.url), { type: "module" }),
});
```

(The `new URL(..., import.meta.url)` form is statically detected by Vite,
webpack 5, Rollup, esbuild, and Parcel.)

## Advanced: protocol & helpers

The package also exports the lower-level pieces for custom integrations:
`unpackBinaryMessage` / `packBinaryMessage`, `probeCapabilities` /
`isCodecSupported`, `BackpressureController` / `KeyframeGate`, the event
normalizers (`normalizePointerEvent`, `pointerToFramebuffer`, `computeBackingSize`,
…), and all the wire/event TypeScript types. See [Internals](internals.md) for the
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
