# Multiple streams per server

One `serve(w, h)` hosts **one** framebuffer. But a single process often has several
things to show at once — different cameras or viewports of a simulation, a dashboard
of independent plots, a per-user view. Multiple streams let you host all of them
from **one port**, each an independent [`Display`](reference.md#pdum.rfb.display.Display)
a browser attaches to **by URL path**, discoverable over a small REST listing.

This is distinct from two things it is sometimes confused with:

- **Multi-client** (many viewers of *one* stream) already works — the push `Display`
  fans each frame out to every viewer with its own session and backpressure. Streams
  are the *other* axis: many independent framebuffers.
- **WebTransport** is unrelated — streams work fine over plain WebSocket.

A stream is just "a `Display` plus its encoder config", and routing is purely
additive: sessions, encoders, backpressure, auth, and "still after settle" are all
unchanged.

## The hub: `serve_server()`

```python
import pdum.rfb as rfb

server = await rfb.serve_server(port=8765)
camera = server.add_stream("camera", 1280, 720)            # ws://host:8765/camera
depth  = server.add_stream("depth", 640, 480, has_h264=False)  # ws://host:8765/depth

while running:
    for ev in camera.poll_events() + depth.poll_events():
        ...
    camera.publish(render_camera())
    depth.publish(render_depth())
    await asyncio.sleep(1 / 30)

await server.aclose()   # stops the listener and disconnects every viewer
```

Each `add_stream(name, w, h, **config)` returns its own `Display`. Streams are
**independent**: per-stream resolution, `bitrate`, `gpu`, `adaptive`, `still_after`,
and `authenticate`. One can be a GPU H.264 stream and another a dependency-light
image stream. Add streams before or after the listener starts — clients reach a
stream at `ws://host/<name>` either way.

## Keeping the one-liner: `serve()`

The single-stream `serve(w, h)` is unchanged and still returns a `Display`. Under the
hood it is now a hub with one `"default"` stream, reachable through `display.server`:

```python
display = await rfb.serve(1280, 720)             # the "default" stream
overview = display.server.add_stream("overview", 320, 240)
...
await display.aclose()   # closing the returned Display tears down the whole hub
```

A browser that connects with **no path** (`ws://host/`) lands on `"default"`, so
existing clients and `RemoteFramebufferView({ url })` keep working untouched.

## In the browser

Point the view's URL at the stream's path — nothing else changes:

```js
new RemoteFramebufferView({ url: "ws://localhost:8765/camera", canvas });
new RemoteFramebufferView({ url: "ws://localhost:8765/depth",  canvas: canvas2 });
```

Connecting to an unknown stream closes the socket with application code **4404**.

## REST: discover and inspect streams

The same port answers a small HTTP side channel:

| Route | Returns |
| ----- | ------- |
| `GET /health` | `ok` |
| `GET /streams` | `[{name, width, height, fps, clients}, ...]` |
| `GET /streams/<name>/metrics` | per-session metric snapshots for that stream |

For backward compatibility the single-stream routes (`GET /metrics`,
`GET /recorded-events`, `GET /recorded-events/reset`) act on the `"default"` stream
when one exists.

```bash
curl http://localhost:8765/streams
# [{"name": "camera", "width": 1280, "height": 720, "fps": 30, "clients": 2},
#  {"name": "depth",  "width": 640,  "height": 480, "fps": 30, "clients": 0}]
```

## Per-stream authorization

The [`AuthContext`](reference.md#pdum.rfb.auth.AuthContext) passed to a stream's
`authenticate` hook carries `ctx.stream`, so one hook can authorize differently per
stream (or you can pass a different hook to each `add_stream`):

```python
async def authenticate(ctx):
    user = verify(ctx.token)
    if user is None:
        return None
    return user if user.may_view(ctx.stream) else None

server.add_stream("admin", 1280, 720, authenticate=authenticate)
server.add_stream("public", 1280, 720)   # no auth
```

## Lifecycle

- `serve_server()` → a `Server`; `await server.aclose()` stops the listener and
  disconnects every viewer of every stream.
- `serve()` → the default `Display`; `await display.aclose()` tears down the whole
  hub (the one-liner contract). Use `serve_server()` when you want to manage the hub
  explicitly.
- `server.port` (and `display.port`) report the **bound** port — handy with
  `port=0`, which picks a free one.
