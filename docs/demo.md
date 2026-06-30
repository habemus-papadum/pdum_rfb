# The interactive demo harness (`pdum-rfb demo`)

`pdum-rfb demo` is a single command that brings up the **whole stack** so you can try it
by hand: it publishes a live feed, serves the browser client, and gives you a terminal UI
(Textual) to switch demo scenes, switch encode backends **live on one WebSocket**, retune
bitrate/fps, and watch per-session stats. It is a dev/eval tool, not a runtime dependency.

```bash
uv sync --extra demo            # or: pip install 'habemus-papadum-rfb[demo]'
uv run pdum-rfb demo            # prints a URL; open it in your browser
```

What the one command starts:

* an in-process [`serve()`](guide_python.md) `Display` publishing the selected scene;
* the browser client via **Vite** dev mode (it finds `widgets/` in the repo automatically)
  — the TUI prints a clickable `http://127.0.0.1:5173/?ws=ws://127.0.0.1:8765` URL;
* the **Textual control panel**.

## The control panel

| Panel | What it does |
| --- | --- |
| **Demo scene** | Pick a scene; the render loop swaps what it publishes (no reconnect). |
| **Encode backend** | Pick image/JPEG·PNG·WebP, libx264, VideoToolbox, or NVENC; the live switch reconfigures every connected viewer and re-sends `config`. The browser follows data-driven on the next keyframe. |
| **Quality** | Set bitrate (`8M`, `800k`, …) and fps, then **Apply** — encoders rebuild for every viewer. |
| **Live stats** | Per-session fps / bitrate / encode-ms / RTT / inflight / dropped, refreshed each second. |

Only backends that actually run on your box are listed (the image modes are always there;
video backends are gated by their availability probe — `vtenc` on macOS, the `nvenc_*`
backends on Linux/NVIDIA). The scenes likewise hide what they can't run (the MLX/Metal
shader scene only appears on Apple Silicon with MLX installed).

The live backend switch rides `pdum.rfb.server._StreamHost.switch_backend`, which sets each
session's pending reconfigure; it is applied **between encode steps** so it never races the
off-thread encode. See `docs/internals.md` for the session loop.

## Scenes

`test_card`, `bouncing_box`, `gradient`, `checkerboard` (CPU patterns reused from the test
suite), `plasma` (animated, high-entropy — good for comparing image vs video codecs),
`paint` (interactive — drag the mouse to draw; demonstrates the browser→server input
round-trip), and `mlx_shader` (a custom MLX Metal compute kernel; macOS + MLX only).

Adding one is a few lines in `src/pdum/rfb/demos.py`: write a `make()` returning an object
with `frame(seq, t, width, height) -> np.ndarray` (and optionally `on_event(event)`), then
append a `Demo` to `DEMOS`.

## Options

```
uv run pdum-rfb demo --width 1280 --height 720 --port 8765 --web-port 5173 \
                     --fps 30 --bitrate 8M [--no-vite] [--web-url URL] [--widgets-dir DIR]
```

`--no-vite` (or `--web-url`) when you serve the client yourself (e.g. a built `dist/`).

## Headless self-test

`--smoke` runs the same machinery with a scripted WebSocket client — no browser, no
terminal UI. It connects, switches through **every** available backend on the one socket,
decodes a frame from each, retunes quality, and round-trips an input event:

```bash
uv run pdum-rfb demo --smoke
```

This is the CI-grade proof the feature works (see `pdum.rfb.demo_tui.smoke` and
`tests/test_demo.py`). It runs anywhere — backends/scenes needing absent hardware or deps
are filtered out, so on a plain box it still exercises the image and (if PyAV is present)
libx264 paths.
