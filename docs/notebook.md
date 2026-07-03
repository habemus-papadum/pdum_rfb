# Notebook widget (Jupyter / marimo)

`pdum.rfb` renders in Python and views in the browser. In a notebook that browser is
your Jupyter/marimo cell: `display.widget()` returns an
[anywidget](https://anywidget.dev) that streams the server framebuffer straight into the
output area.

The key difference from `jupyter_rfb`: frames travel over a **plain WebSocket owned by the
widget**, *not* the Jupyter kernel comm. The kernel channel only carries a handful of
string traits (`url`, `token`, `state`, …) — never pixels — so a high-frame-rate stream
never touches the notebook protocol, and the same widget works identically in Jupyter,
JupyterLab, VS Code, and marimo.

Install the extra:

```bash
uv add 'habemus-papadum-rfb[anywidget]'
# or:  pip install 'habemus-papadum-rfb[anywidget]'
```

The widget's JavaScript ships **prebuilt inside the wheel** (a single self-contained ESM
with the Web Worker inlined). There is no Node/npm step at install time and no runtime CDN
fetch.

A runnable version of the quick start below lives in
[`docs/demos/anywidget.ipynb`](demos/anywidget.ipynb). Two even smaller "wire it up in two
cells" demos — one cell starts a CPU/NumPy `serve()`, the next drops in the viewer, one
kernel hosting both — are [`docs/demos/jupyter-demo.ipynb`](demos/jupyter-demo.ipynb)
(Jupyter) and [`docs/demos/marimo-demo.py`](https://github.com/habemus-papadum/pdum_rfb/blob/main/docs/demos/marimo-demo.py)
(marimo). The quickest way to run either — no clone needed — is the bundled CLI launcher
(`[demo]` extra), which copies the notebook to a working dir and opens the tool on it:

```bash
uvx --from 'habemus-papadum-rfb[demo]' pdum-rfb jupyter-demo   # JupyterLab
uvx --from 'habemus-papadum-rfb[demo]' pdum-rfb marimo-demo    # marimo
```

Both need the widget to reach the kernel's WebSocket port — straightforward in a **deployed**
notebook, but a sandboxed/remote-without-proxy setup may block it (see [Remote / HTTPS
notebooks](#remote--https-notebooks-same-origin)).

## Quick start (local)

```python
import itertools
import numpy as np
import pdum.rfb as rfb
from pdum.rfb.notebook import publish_loop

# `await` works at the top level in Jupyter/marimo — a loop is already running.
display = await rfb.serve(1280, 720, port=0)      # port=0 -> OS picks a free port
frames = itertools.count()

def render():
    t = next(frames) % 256
    img = np.zeros((720, 1280, 3), dtype=np.uint8)
    img[:, :, 2] = t
    return img

task = publish_loop(display, render, fps=30)      # non-blocking background task
display.widget()                                   # -> batteries viewer in the cell
```

`publish_loop(display, render, *, fps=30)` schedules `render() → display.publish()` on the
notebook's event loop and returns the `asyncio.Task` immediately, so the cell doesn't
block. You own the cadence — call `publish()` yourself instead if your updates are
sparse/on-demand rather than a fixed frame rate.

Tear down when done:

```python
task.cancel()
await display.aclose()
```

### The two widget tiers

`display.widget()` returns one of two anywidgets (both defined in `pdum.rfb.notebook`):

| Call | Class | Chrome |
|---|---|---|
| `display.widget()` | `RfbViewer` | **batteries** — status pill, latency badge, toggleable stats HUD, toolbar (screenshot / fullscreen / transport toggle / HUD toggle) |
| `display.widget(batteries=False)` | `RfbCanvas` | **bare** — just the framebuffer canvas filling the cell; you supply the chrome/CSS |

You can also construct them directly (e.g. for marimo, or to set traits up front):

```python
from pdum.rfb.notebook import RfbViewer, RfbCanvas

RfbViewer(port=display.port, stream="default", height=480, show_stats=False)
```

Extra keyword args to `display.widget()` become widget traits, so
`display.widget(show_toolbar=False)` renders the batteries viewer with the toolbar hidden,
and `display.widget(height=720)` sizes the output (a notebook output `<div>` is 0-height
by default, so without `height` the canvas would fall back to 320×240).

## Many widgets, one port

**One widget = one Web Worker + one WebSocket.** Each widget owns an isolated decode
pipeline (its own backpressure, keyframe, and decoder state) and tears down cleanly when
the cell is re-executed. The Python `Server` hub multiplexes any number of streams on a
**single port**, so N cells = N widgets = N independent streams — the only scaling cost is
N browser worker threads (browsers handle dozens comfortably).

```python
server = await rfb.serve_server(port=0)

cam = server.add_stream("camera", 1280, 720)      # ws://…/camera
depth = server.add_stream("depth", 640, 480)      # ws://…/depth

publish_loop(cam, render_camera, fps=30)
publish_loop(depth, render_depth, fps=10)

cam.widget()        # in one cell
depth.widget()      # in another
```

> A single SharedWorker multiplexing many views is a possible future optimization, but v1
> keeps one worker per widget for isolation and simple teardown.

## Remote / HTTPS notebooks (same-origin)

**Rule of thumb — who controls the environment?** If *you* launched the notebook server —
`localhost`, a VS Code Remote / SSH tunnel (the port forwards automatically), your own
`jupyter lab` — the framebuffer's WebSocket port is reachable and the [local recipe](#quick-start-local)
just works. If your notebook runs on a **locked-down, multi-tenant JupyterHub that IT deployed
and you only consume**, you don't control the network path: the `serve()` port lives on the
kernel's container and isn't exposed, so you must route the framebuffer **same-origin** through
the hub (below). This is the flip side of not riding the Jupyter kernel comm — a comm-based
tool like `jupyter_rfb` works in a deployed hub out of the box (the hub already proxies the
comm) but can't reach `pdum.rfb`'s frame rates.

The local recipe above builds a `ws://<hostname>:<port>/<stream>` URL, which only works
when the page is served over **plain `http://` on a host that can reach that port**
(typically `localhost`). Under `https://` — JupyterHub, a hosted notebook, anything behind
TLS — a separate `ws://` port is blocked as mixed content, and the standalone `serve()`
listener has no TLS of its own.

The fix is to expose the framebuffer **same-origin**, so it shares the page's TLS *and*
its auth cookie. Mount the ASGI hub endpoint (`[asgi]` extra) inside the app that serves
the notebook, and pass `base_path=` to the widget:

```python
import pdum.rfb as rfb
from pdum.rfb.asgi import rfb_hub_endpoint

server = await rfb.serve_server(port=0)            # the in-process hub (its ws:// port is unused here)
stream = server.add_stream("scene", 1280, 720)
publish_loop(stream, render, fps=30)

# In your Starlette/FastAPI app (the one behind the notebook's origin):
app.add_websocket_route("/rfb/{stream}", rfb_hub_endpoint(server))

# In the notebook cell:
stream.widget(base_path="/rfb")
```

With `base_path="/rfb"` the widget connects to
`wss://<page-host>/rfb/scene` — same origin, no mixed content, and the endpoint's auth hook
receives the request's `AuthContext.cookies` / `.headers`, so the notebook's existing
session/OAuth cookie authenticates the stream (no separate token needed). See
[ASGI / Starlette adapter](asgi.md) for the endpoint details and per-stream auth.

**JupyterHub without your own ASGI app:** run the standalone `serve_server()` listener and
expose it through [`jupyter-server-proxy`](https://jupyter-server-proxy.readthedocs.io) at
a path like `/proxy/<port>/`; pass that path as `base_path`. The widget then rides the
proxy's same-origin `wss://` upgrade.

### How the widget resolves its URL

In priority order:

1. **`url`** — an explicit trait always wins (full override).
2. **`base_path`** — same-origin: `wss://<page-host><base_path>/<stream>` under `https`,
   `ws://…` under `http`. Use this for remote/HTTPS.
3. **`host` + `port`** — `ws://<host>:<port>/<stream>`; `host="auto"` (the default from
   `display.widget()` when the server bound to a wildcard address) uses the page's own
   hostname. This is the local path.

## Theming the batteries chrome

The batteries tier (`RfbViewer`) ships opt-in CSS that is themeable without touching
markup, via CSS custom properties on `.rfb-root`. Inject a `<style>` from a cell (or set
them in a JupyterLab theme):

```python
from IPython.display import HTML, display as ipy_display

ipy_display(HTML("""
<style>
.rfb-root {
  --rfb-accent: #7c3aed;
  --rfb-bg: #0b0b10;
  --rfb-fg: #e8e8f0;
  --rfb-radius: 10px;
}
</style>
"""))
```

Available knobs include `--rfb-bg`, `--rfb-fg`, `--rfb-accent`, `--rfb-overlay-bg`,
`--rfb-status-{connecting,open,error}`, `--rfb-radius`, and `--rfb-font`. For structural
changes, use `batteries=False` (`RfbCanvas`) and build your own chrome around the
observable readback traits (below). The stable part classes (`.rfb-viewport`,
`.rfb-toolbar`, `.rfb-button`, `.rfb-status`, `.rfb-badge`, `.rfb-hud`, `.rfb-banner`) are
also available to target directly.

## Reading connection state back into Python

The widget writes three observable traits back to the kernel (throttled to ~1 Hz for
stats):

- `state` — `"connecting" | "open" | "negotiated" | "closed" | "error"`.
- `stats` — a dict: `framesDisplayed`, `framesDropped`, `lastDisplayedSeq`,
  `decodeQueueSize`, `transport`, plus optional server-side fields.
- `last_error` — the most recent error message (empty when healthy).

Observe them like any traitlet:

```python
w = display.widget()

def on_state(change):
    print("connection:", change["new"])

w.observe(on_state, names="state")
w
```

## marimo

The same bundle drives marimo — wrap the widget so marimo tracks it:

```python
import marimo as mo
from pdum.rfb.notebook import RfbViewer

viewer = mo.ui.anywidget(RfbViewer(port=display.port, stream="default"))
viewer
```

## How frames reach the canvas (present path)

By default the widget draws each frame on the **main thread**: a plain `<canvas>` the
decode worker feeds frames to (it transfers each decoded `VideoFrame`/`ImageBitmap` back and
the main thread draws it with `drawImage`). This is deliberately robust to embedding hosts
that **reparent or re-render the widget subtree after it mounts** — notably marimo, which
renders the anywidget inside a shadow root and re-runs the output cell on state changes. The
alternative (transferring an `OffscreenCanvas` to the worker) is a hair cheaper, but under
that reparenting the transferred placeholder can be severed from the compositor, leaving a
**black canvas even though the worker is decoding frames correctly**. The main-thread canvas
has no transferred placeholder to sever, so the picture follows the element wherever the
framework moves it.

The path is chosen by a **host-aware default**: `main_thread_present` is `True` only when the
widget is created inside a live marimo notebook (detected via `marimo.running_in_notebook()`),
and `False` everywhere else — Jupyter and JupyterLab don't reparent, so they take the
lower-overhead OffscreenCanvas transfer path (Mode A), which is also the path that carries the
backend-switch / zoom chrome. Only marimo pays for the main-thread draw.

Override it explicitly (connect-time — mutating it rebuilds the view) if you hit a different
reparenting host, or to force a path for measurement:

```python
display.widget(main_thread_present=True)    # force the reparent-safe main-thread draw
display.widget(main_thread_present=False)   # force the OffscreenCanvas transfer path (Mode A)
```

At notebook cadence the cost difference is negligible; the reason to prefer Mode A off-marimo
is that the live backend-switch and zoom/pan chrome are Mode A features (the main-thread
present path is a limited presenter — capture and fit, but not live backend switching).

## CSP and mixed content

- **Mixed content:** under `https://`, always use the same-origin `base_path` path (§
  *Remote / HTTPS*). A `ws://` URL from an `https://` page is blocked.
- **Blob worker + CSP:** the widget spawns its decoder in an inlined blob Web Worker.
  Jupyter's default CSP permits this. A hardened deployment that sets a restrictive
  `worker-src`/`script-src` can block the blob; the escape hatch is the core client's
  `workerFactory` option (serve the worker from a same-origin URL) — file an issue if you
  need this surfaced as a widget trait.

## Testing

The notebook path is covered headlessly:

- `tests/test_notebook_widget.py` — when built, the (git-ignored, on-demand) bundle is
  present and wired as the widget's ESM/CSS; when absent it degrades to the fallback ESM; the
  two tiers carry the right trait defaults; and `display.ws_url` / `display.widget()` produce
  the expected shape (`pytest.importorskip("anywidget")`).
- `widgets/tests/e2e/anywidget.spec.ts` — Playwright drives the **real** front-end
  `render()` against the booted Python test server through a stubbed anywidget `model`,
  asserting it connects, decodes, displays, and reads `stats` back into the model.
- `widgets/tests/e2e/anywidget-present.spec.ts` — the present-path regression guard: reads the
  **on-screen main-thread canvas** back (not the worker surface) to prove it actually shows the
  streamed pattern, that it keeps showing it after the widget subtree is **reparented** (the
  marimo failure mode), and that the `present=offscreen` path is transferred to the worker
  (unreadable from the main thread — which is why the older readback-only e2e was blind to the
  compositing failure).
- `docs/demos/anywidget.ipynb` runs under `./scripts/test_notebooks.sh` in CI (via
  nbconvert, which runs the Python only — never the widget's JS). The bundle
  `src/pdum/rfb/static/widget.{js,css}` is a git-ignored, on-demand build artifact: CI proves
  it compiles (`pnpm -C widgets build:anywidget`), and the release workflow rebuilds it,
  force-includes it into the wheel, and re-inspects the built wheel to confirm it's present.
