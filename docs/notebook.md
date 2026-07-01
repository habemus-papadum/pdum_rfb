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
[`docs/demos/anywidget.ipynb`](demos/anywidget.ipynb).

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

- `tests/test_notebook_widget.py` — the committed bundle is present and non-empty, the two
  tiers carry the right trait defaults, and `display.ws_url` / `display.widget()` produce
  the expected shape (`pytest.importorskip("anywidget")`).
- `widgets/tests/e2e/anywidget.spec.ts` — Playwright drives the **real** front-end
  `render()` against the booted Python test server through a stubbed anywidget `model`,
  asserting it connects, decodes, displays, and reads `stats` back into the model.
- `docs/demos/anywidget.ipynb` runs under `./scripts/test_notebooks.sh` in CI (via
  nbconvert), and a CI gate rebuilds the bundle and fails if the committed
  `src/pdum/rfb/static/widget.{js,css}` drifts from source.
