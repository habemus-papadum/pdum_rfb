# The interactive demo (`pdum-rfb demo`)

`pdum-rfb demo` brings up the **whole stack as a single web app** so you can try it by
hand. One Python process serves a prebuilt browser UI, a small REST control plane, and the
framebuffer WebSocket(s) — **all on one origin**. The browser holds both the viewer *and*
the controls (scene, encode backend, quality, the richer parameters); the Python side only
serves the app and **logs** what happens. There is **no Node, no Vite, and no terminal UI**
at runtime — it ships prebuilt, so run it with `uvx`:

```bash
uvx --from 'habemus-papadum-rfb[demo]' pdum-rfb demo   # prints a localhost URL; open it
```

It binds **localhost only** by default. Options:

```
pdum-rfb demo --width 1280 --height 720 --port 8000 --fps 30 --bitrate 8M [-v] [--host 0.0.0.0]
```

## The web UI

A dark, hairline-framed **viewport** on the left; a **control rail** on the right, styled
soft and editorial. Everything the old terminal panel did now lives here, beside the pixels:

| Group | What it does |
| --- | --- |
| **Stream** | Pick the shared stream or **mint a private one** (see below). |
| **Scene & backend** | Pick a scene; pick an encode backend — switched **live on the same socket** (the browser follows on the next keyframe). Backends/scenes that can't run on this box are **greyed out** with a reason. |
| **Quality** | Retune bitrate + fps (encoder rebuild), change render size (publishing a new size rebuilds encoders + keyframes), tag the color space (sRGB / Display-P3). |
| **Viewer** | Client-only: swap the **framework** rendering the viewer (Vanilla ⇄ React), the **fit** mode (contain/cover/fill), the **debug** console toggle, plus capture-PNG / fullscreen / reconnect. |
| **Structural** | The per-stream knobs fixed at birth (adaptive, still-after-settle, stats interval, pipeline depth, resize policy). Read-only here — **create a private stream to explore them**. |
| **Session** | Live per-viewer stats (fps / bitrate / encode-ms / RTT / decode queue / dropped) from the server's `stats` push, plus the connection state and any scene error. |

Every control that changes the *stream* is a **REST** call to the Python process (which
logs it); the *viewer* controls are purely client-side.

## Multiple clients & streams

Open the URL in two tabs and you are two viewers of the shared **`default`** stream: one
feed **fans out** to both, each with its own backpressure, and either tab's controls affect
both (last-writer-wins). That is the honest demonstration of the library's core.

Click **＋ private stream** to mint your own stream (`s1`, `s2`, …) with an independent
scene/backend and its own structural parameters — so two tabs can **compare backends or
settings side by side**. Private streams are reaped shortly after their last viewer leaves,
and are capped to bound resources.

## Debug logging

Two halves, both for real debugging:

- **Python → stdout.** The process logs the lifecycle the old TUI showed: startup + URL,
  stream create/destroy, every control command, scene/backend/quality changes, and scene
  render errors. `-v` raises it to `DEBUG`.
- **Browser console.** The **Debug** toggle in the Viewer group flips the core widget's
  `debug` option (also honored from `?debug=1` / persisted in `localStorage`): a tagged
  play-by-play — `[rfb:worker] ws / config / keyframe / frame`, `[rfb:view] state` — plus
  the WebSocket/decoder errors that are otherwise swallowed. Errors surface either way; the
  toggle adds the verbose stream. This is a core widget feature, not demo-only — see the
  `debug` option in [the JavaScript guide](guide_javascript.md).

## Scenes

`test_card`, `bouncing_box`, `gradient`, `checkerboard` (CPU patterns from the test suite),
`plasma` (animated, high-entropy — good for image-vs-video comparisons), `paint`
(interactive — drag to draw; demonstrates the browser→server input round-trip), and
`mlx_shader` (a custom MLX Metal compute kernel; macOS + MLX only). Add one in a few lines
in `src/pdum/rfb/demos.py` (see the module docstring).

## Headless self-test (`--smoke`)

`--smoke` drives the **real ASGI app in-process** (Starlette `TestClient`) with a scripted
WebSocket client — no browser, no uvicorn:

```bash
pdum-rfb demo --smoke
```

It reads `/demo/capabilities`, switches through **every** available backend over REST on
one socket (decoding a frame from each), retunes quality, switches scene + round-trips an
input event, checks a **2-viewer fan-out**, and runs a **private-stream create → connect →
destroy** cycle. This is the CI-grade proof the feature works (see
`pdum.rfb.demo_server.smoke` and `tests/test_demo.py`), and it runs anywhere — absent
hardware/deps are filtered out.

## Under the hood (for contributors)

The app is a Starlette ASGI app served by uvicorn (`pdum.rfb.demo_server`): `StaticFiles`
for the SPA, REST routes for control, and `rfb_hub_endpoint` for the framebuffer WS — the
hub's `websockets` listener is never started, so everything shares one origin. The REST
surface: `GET /demo/capabilities` + `/demo/state`; `POST /demo/streams` (+ `DELETE
/demo/streams/{name}`); `POST /demo/streams/{name}/{scene,backend,quality,params}`. The SPA
is a small Vite project (`widgets/packages/demo-app/`) built to committed package data:

```bash
pnpm -C widgets build:demo     # -> src/pdum/rfb/static/demo/ (ships in the wheel)
pnpm -C widgets e2e:demo       # Playwright e2e that boots `pdum-rfb demo` and drives the UI
```

The far simpler **two-process dev demo** (`python -m pdum.rfb.server` + `pnpm dev`) is a
contributor tool, documented in [the development guide](development.md).
