# ASGI / Starlette adapter

By default `pdum.rfb` runs its **own** WebSocket listener (`serve()`), which is
perfect for a standalone viewer and pulls in only `websockets`. But when you already
have a web app — a Starlette or FastAPI service with its own TLS, routing, and login
— you usually want the framebuffer to live **inside** it, on the **same origin**, so
it shares the app's session/OAuth cookie and certificate.

The ASGI adapter does exactly that. It is a **second front-end over the same
core** — the identical [`Display`](reference.md#pdum.rfb.display.Display) and
[`RfbSession`](reference.md#pdum.rfb.session.RfbSession), the same encoders,
backpressure, auth, multi-client fan-out, multiple streams, and "still after
settle". Nothing about the standalone `serve()` path changes; this is purely
additive and **opt-in**.

> **Not a migration.** Adopting ASGI is a choice, not a requirement. `serve()`
> keeps working with zero extra dependencies. Reach for the adapter only when you
> want same-origin hosting in an existing ASGI app.

## Install

```bash
pip install 'habemus-papadum-rfb[asgi]'   # adds Starlette
```

## One display in a Starlette app

The ASGI server owns the event loop, so the shape is: build your `Display` at
startup, run your publish loop as a background task (a lifespan handler is the
natural home), and mount the endpoint.

```python
import asyncio, contextlib
import pdum.rfb as rfb
from pdum.rfb.asgi import rfb_endpoint
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute

display = rfb.Display(1280, 720)

@contextlib.asynccontextmanager
async def lifespan(app):
    async def publish_loop():
        while True:
            display.publish(render())
            await asyncio.sleep(1 / 30)
    task = asyncio.create_task(publish_loop())
    try:
        yield
    finally:
        task.cancel()

app = Starlette(lifespan=lifespan, routes=[
    WebSocketRoute("/rfb", rfb_endpoint(display)),
])
```

`rfb_endpoint(display, **config)` takes the same encoder/transport keywords as
`serve()` — `has_h264`, `has_nvenc`, `gpu`, `bitrate`, `adaptive`, `still_after`,
`max_inflight`, and a per-endpoint `authenticate`. In the browser, point the view at
the mounted path on your app's origin:

```js
new RemoteFramebufferView({ url: "wss://app.example.com/rfb", canvas });
```

## Same-origin cookie auth

Because the handshake now flows through your ASGI app, the
[`AuthContext`](reference.md#pdum.rfb.auth.AuthContext) handed to your `authenticate`
hook carries the request **cookies** and **headers** — so you can authorize off the
session the user already has, with no token plumbing in the browser:

```python
async def authenticate(ctx):
    user = await session_store.get(ctx.cookies.get("session"))
    return user or None    # None closes the socket with code 4401

WebSocketRoute("/rfb", rfb_endpoint(display, authenticate=authenticate))
```

(The standalone `serve()` path still works the same way; there the credential
arrives in the `hello` message as `ctx.token` because a browser `WebSocket` cannot
set request headers.)

## Multiple streams

Mount [`rfb_hub_endpoint`](reference.md#pdum.rfb.asgi.rfb_hub_endpoint) on a path that
captures a `{stream}` parameter to expose a whole [hub](multiple_streams.md) of named
displays through one app route:

```python
server = rfb.Server()                        # a registry; no listener of its own
cam   = server.add_stream("camera", 1280, 720)
depth = server.add_stream("depth", 640, 480, has_h264=False)

app = Starlette(lifespan=lifespan, routes=[
    WebSocketRoute("/rfb/{stream}", rfb_hub_endpoint(server)),
])
# ws://app/rfb/camera, ws://app/rfb/depth; unknown stream closes with 4404
```

Here `Server` is used purely as a stream registry — you don't call `serve_server()`,
since the ASGI server, not `pdum.rfb`, owns the listener and the loop.

## FastAPI

FastAPI is ASGI/Starlette under the hood, so the same endpoints mount directly:

```python
from fastapi import FastAPI

app = FastAPI(lifespan=lifespan)
app.add_websocket_route("/rfb", rfb_endpoint(display))
```

## How it maps onto the core

`rfb_endpoint` builds the same internal per-stream host the listener uses and drives
one session per connection over a small adapter that wraps the Starlette `WebSocket`.
The adapter presents the exact surface the session already speaks
([`Channel`](reference.md#pdum.rfb.transport.Channel): `send` + async iteration) and
translates a `WebSocketDisconnect` onto the `ConnectionClosed` the session already
treats as a normal end-of-life — which is why the negotiation, encoder, and session
code are **byte-for-byte the same** across both front-ends.

The other transport on the roadmap, **WebTransport (HTTP/3)**, would slot into the
same seam; it stays deferred (Chromium-only, modest benefit for sparse viz) — see the
[roadmap](roadmap.md).
