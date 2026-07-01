"""The ``pdum-rfb demo`` web app: a Starlette control plane over a framebuffer hub.

One ``pdum-rfb demo`` process serves a **self-contained web app** — the prebuilt SPA
(committed under ``static/demo/``), a small **REST** control plane, and the framebuffer
**WebSocket(s)** — all on one origin. There is no Node, no Vite, and no terminal UI: the
browser holds both the remote-framebuffer viewer *and* the controls (scene / encode
backend / quality / the richer parameters), and drives the server with REST calls. The
Python side only serves the app and **logs** lifecycle to stdout.

Architecture
------------
* A :class:`~pdum.rfb.server.Server` **hub** owns the named streams, but its
  ``websockets`` listener is **never started** — every connection is driven through
  Starlette via :func:`~pdum.rfb.asgi.rfb_hub_endpoint`, so REST + static + WS share one
  uvicorn origin.
* A :class:`DemoStreamManager` owns, per stream, the :class:`_DemoState` (which scene is
  live) and the publish task (:func:`_render_loop`).
* **Streams model the two multi-client modes.** The shared ``"default"`` stream is
  *coupled* — many viewers see the same frames and any client's control affects them all
  (fan-out). A client can also mint a *private* stream (its own scene / backend / and the
  structural parameters chosen at birth), so two tabs can compare backends side by side.
  Private streams are reaped a short grace period after their last viewer leaves and are
  capped to bound resources.

Live vs structural parameters
-----------------------------
``scene`` / ``backend`` / ``bitrate`` / ``fps`` / ``resolution`` / ``color`` are cheap to
change on a running stream (the existing live-switch / resize / per-frame-tag paths), so
they are editable anytime. The *structural* parameters (``adaptive``, ``still_after``,
``stats_interval``, ``encode_pipeline_depth``, ``resize_policy``) are fixed at
``add_stream`` time — you explore them by **creating a private stream**.

A headless :func:`smoke` drives the real ASGI app in-process (Starlette ``TestClient``):
capabilities, every backend switched over REST on one socket, a multi-viewer fan-out
check, and a private-stream create → connect → destroy cycle. It is the CI-grade proof.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import logging
import platform
import sys
import time
from pathlib import Path
from typing import Any

from .demos import DEMOS, available_demos, get_demo
from .server import DEFAULT_STREAM, Server
from .types import DISPLAY_P3, SRGB

log = logging.getLogger("pdum.rfb.demo")

#: Where the prebuilt SPA lives once ``pnpm -C widgets build:demo`` has run.
STATIC_DEMO_DIR = Path(__file__).resolve().parent / "static" / "demo"


# --- bitrate helpers --------------------------------------------------------


def _parse_bitrate(text: str | int) -> int:
    """Parse ``"8M"`` / ``"800k"`` / ``"8000000"`` (or an int) into bits per second."""
    if isinstance(text, (int, float)):
        return int(text)
    s = str(text).strip().lower().replace("bps", "")
    mult = 1
    if s.endswith("m"):
        mult, s = 1_000_000, s[:-1]
    elif s.endswith("k"):
        mult, s = 1_000, s[:-1]
    return int(float(s) * mult)


def _fmt_bitrate(bps: int) -> str:
    return f"{bps / 1e6:.1f}M" if bps >= 1_000_000 else f"{bps // 1000}k"


# --- capability discovery (scenes + backends, with availability + reasons) --


def _probe(modpath: str, fn: str) -> bool:
    try:
        return bool(getattr(importlib.import_module(modpath), fn)())
    except Exception:
        return False


def backend_catalog() -> list[dict[str, Any]]:
    """Every encode backend the demo knows, each tagged available/why-not for greying-out.

    ``id`` is what :meth:`~pdum.rfb.server._StreamHost.switch_backend` accepts:
    ``image:<mode>`` or a registered video-encoder name. The image modes are always
    available; the video backends are gated by their runtime probe, and unavailable ones
    carry a short ``reason`` so the panel can explain the grey.
    """
    darwin = sys.platform == "darwin"
    have_av = importlib.util.find_spec("av") is not None
    entries: list[tuple[str, str, bool, str]] = [
        ("image:jpeg", "Image · JPEG (Pillow)", True, ""),
        ("image:png", "Image · PNG (lossless)", True, ""),
        ("image:webp", "Image · WebP (Pillow)", True, ""),
        ("h264_cpu", "H.264 · libx264 (CPU, PyAV)", have_av, "needs PyAV ([h264] extra)"),
        (
            "vtenc",
            "H.264 · VideoToolbox (Apple HW)",
            _probe("pdum.rfb.encoders.vtenc", "vtenc_available"),
            "macOS + Apple VideoToolbox only ([mac-vt] extra)",
        ),
        (
            "nvenc_cpu",
            "H.264 · NVENC (host input)",
            _probe("pdum.rfb.encoders.nvenc_cpu", "nvenc_cpu_available"),
            "needs an NVIDIA NVENC GPU + PyAV",
        ),
        (
            "nvenc_gpu_pyav",
            "H.264 · NVENC zero-copy (PyAV≥18)",
            _probe("pdum.rfb.gpu", "cuda_zerocopy_available"),
            "needs CuPy + PyAV≥18",
        ),
        (
            "nvenc_gpu_pdum",
            "H.264 · NVENC SDK (pdum.nvenc)",
            _probe("pdum.rfb.encoders.nvenc_gpu_pdum", "nvenc_gpu_pdum_available"),
            "needs habemus-papadum-nvenc + CUDA GPU",
        ),
    ]
    _ = darwin  # (reserved for future per-OS labels)
    return [{"id": i, "label": lbl, "available": ok, "reason": "" if ok else why} for i, lbl, ok, why in entries]


def available_backends() -> list[tuple[str, str]]:
    """``(id, label)`` for every backend usable on this box (the greenlit subset)."""
    return [(b["id"], b["label"]) for b in backend_catalog() if b["available"]]


def scene_catalog() -> list[dict[str, Any]]:
    """Every built-in scene, tagged available/why-not for greying-out."""
    out: list[dict[str, Any]] = []
    for d in DEMOS:
        try:
            ok = bool(d.available())
        except Exception:
            ok = False
        reason = "" if ok else "unavailable on this platform (missing deps/hardware)"
        out.append(
            {
                "key": d.key,
                "name": d.name,
                "description": d.description,
                "tags": list(d.tags),
                "available": ok,
                "reason": reason,
            }
        )
    return out


def _controls_schema() -> list[dict[str, Any]]:
    """A server-authored description of the panel's controls, so the SPA renders them
    generically (label, type, choices, help) and knows whether a change is a REST call
    (``scope:"stream"``) or purely client-side (``scope:"viewer"``)."""
    return [
        {
            "id": "scene",
            "label": "Scene",
            "type": "scene",
            "scope": "stream",
            "help": "What the render loop publishes.",
        },
        {
            "id": "backend",
            "label": "Encode backend",
            "type": "backend",
            "scope": "stream",
            "help": "Live-switched on the same socket; the browser follows on the next keyframe.",
        },
        {
            "id": "bitrate",
            "label": "Bitrate",
            "type": "text",
            "scope": "stream",
            "default": "8M",
            "help": "Target H.264/NVENC bitrate, e.g. 8M or 800k. Ignored by image modes.",
        },
        {
            "id": "fps",
            "label": "FPS",
            "type": "int",
            "scope": "stream",
            "min": 1,
            "max": 120,
            "default": 30,
            "help": "Publish + encoder IDR-cadence target.",
        },
        {
            "id": "width",
            "label": "Width",
            "type": "int",
            "scope": "stream",
            "min": 16,
            "max": 3840,
            "help": "Render width (even). Publishing a new size rebuilds encoders + keyframes.",
        },
        {
            "id": "height",
            "label": "Height",
            "type": "int",
            "scope": "stream",
            "min": 16,
            "max": 2160,
            "help": "Render height (even).",
        },
        {
            "id": "color",
            "label": "Color",
            "type": "choice",
            "scope": "stream",
            "choices": ["srgb", "display-p3"],
            "default": "srgb",
            "help": "Tag the stream color space (P3 = Apple wide-gamut SDR).",
        },
        # Structural — chosen at private-stream creation (read-only on the shared stream).
        {
            "id": "adaptive",
            "label": "Adaptive quality",
            "type": "bool",
            "scope": "create",
            "default": False,
            "help": "Bitrate→fps→inflight controller reacting to decode-queue depth + RTT.",
        },
        {
            "id": "still_after",
            "label": "Still after settle (s)",
            "type": "float",
            "scope": "create",
            "help": "Send a lossless PNG / clean IDR this many seconds after frames settle (e.g. 0.15). Blank = off.",
        },
        {
            "id": "stats_interval",
            "label": "Stats interval (s)",
            "type": "float",
            "scope": "create",
            "default": 1.0,
            "help": "Server→client stats push cadence.",
        },
        {
            "id": "encode_pipeline_depth",
            "label": "Pipeline depth",
            "type": "int",
            "scope": "create",
            "min": 0,
            "max": 8,
            "default": 0,
            "help": "0 = synchronous 1-in-1-out; >0 pipelines the NVENC path for throughput.",
        },
        {
            "id": "resize_policy",
            "label": "Resize policy",
            "type": "choice",
            "scope": "create",
            "choices": ["publisher", "match_client"],
            "default": "publisher",
            "help": "match_client: the render stream follows the viewer's viewport.",
        },
        {
            "id": "max_render_dimension",
            "label": "Max render dim (px)",
            "type": "int",
            "scope": "create",
            "help": "Cap either dimension under match_client (AR-preserving). Blank = no cap.",
        },
        # Viewer — purely client-side (no REST).
        {
            "id": "fit",
            "label": "Fit",
            "type": "choice",
            "scope": "viewer",
            "choices": ["contain", "cover", "fill"],
            "default": "contain",
            "help": "How the frame maps into the viewport when aspect ratios differ.",
        },
        {
            "id": "framework",
            "label": "Framework",
            "type": "choice",
            "scope": "viewer",
            "choices": ["vanilla", "react", "svelte", "solid"],
            "default": "vanilla",
            "help": "Which batteries wrapper renders the viewer (live-swapped).",
        },
        {
            "id": "debug",
            "label": "Debug logging",
            "type": "bool",
            "scope": "viewer",
            "default": False,
            "help": "Verbose client-side console logging (errors first).",
        },
    ]


def capabilities() -> dict[str, Any]:
    """The payload behind ``GET /demo/capabilities`` — drives greying-out + control render."""
    mach = platform.machine()
    syst = platform.system()
    return {
        "scenes": scene_catalog(),
        "backends": backend_catalog(),
        "controls": _controls_schema(),
        "platform": {
            "system": syst,
            "machine": mach,
            "is_mac_arm": syst == "Darwin" and mach in ("arm64", "aarch64"),
            "python": ".".join(map(str, sys.version_info[:3])),
        },
        "limits": {"private_stream_cap": 8},
    }


# --- per-stream demo scene state -------------------------------------------


class _DemoState:
    """The mutable, live-editable state of one stream: which scene, size, and color tag.

    Both the render loop and the REST handlers mutate this (one event loop, no locks).
    Structural parameters are *not* here — they live on the ``_StreamHost``/``Display``,
    set once at :meth:`Server.add_stream`.
    """

    def __init__(self, first_key: str, width: int, height: int) -> None:
        self.active_key = first_key
        self.instance = get_demo(first_key).make()
        self.width = width
        self.height = height
        self.color: str | None = None  # None | "srgb" | "display-p3"
        self.last_error: str | None = None

    def select(self, key: str) -> None:
        self.instance = get_demo(key).make()
        self.active_key = key
        self.last_error = None

    def color_obj(self) -> Any:
        if self.color == "display-p3":
            return DISPLAY_P3
        if self.color == "srgb":
            return SRGB
        return None


async def _render_loop(display: Any, state: _DemoState, host: Any) -> None:
    """Publish the active scene's frames and route browser input back into it.

    Reads size/color from ``state`` (live-editable) and cadence from ``host.fps`` (so a
    live ``set_quality`` retune changes the publish rate). Under ``match_client`` it
    follows the viewer's debounced :attr:`Display.target_size`.
    """
    seq = 0
    t0 = time.monotonic()
    while True:
        inst = state.instance
        if display.resize_policy == "match_client":
            rw, rh = display.target_size or (state.width, state.height)
            ratio: float | None = display.target_ratio
        else:
            rw, rh = state.width, state.height
            ratio = None
        try:
            frame = inst.frame(seq, time.monotonic() - t0, rw, rh)
            display.publish(frame, pixel_ratio=ratio, color=state.color_obj())
        except Exception as exc:  # a buggy scene must not kill the loop
            state.last_error = f"{type(exc).__name__}: {exc}"
        for ev in display.poll_events():
            on_event = getattr(state.instance, "on_event", None)
            if on_event is not None:
                with contextlib.suppress(Exception):
                    on_event(ev.event)
        seq += 1
        await asyncio.sleep(1.0 / max(host.fps, 1))


def _current_backend(host: Any) -> str:
    """The stream's active backend id, as the panel shows it (mirrors the old TUI)."""
    if host._force_transport == "image":
        return f"image:{host.image_mode}"
    if host._force_transport == "h264":
        return host.video_encoder
    return f"auto:{host.video_encoder}"


def _even(n: int, lo: int = 2) -> int:
    n = max(lo, int(n))
    return n - (n % 2)


# --- the stream manager -----------------------------------------------------


class DemoStreamManager:
    """Owns the demo's streams: their scenes, publish tasks, and private-stream lifecycle."""

    def __init__(
        self,
        server: Server,
        *,
        default_width: int,
        default_height: int,
        fps: int = 30,
        bitrate: int = 8_000_000,
        stats_interval: float | None = 1.0,
        private_cap: int = 8,
        reap_grace: float = 10.0,
    ) -> None:
        self.server = server
        self.default_size = (_even(default_width), _even(default_height))
        self.fps = fps
        self.bitrate = bitrate
        self.stats_interval = stats_interval
        self.private_cap = private_cap
        self.reap_grace = reap_grace
        self.states: dict[str, _DemoState] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self._empty_since: dict[str, float] = {}
        self._private_seq = 0
        self._reaper: asyncio.Task | None = None

    def _first_scene(self) -> str:
        demos = available_demos()
        return demos[0].key if demos else DEMOS[0].key

    # --- create / destroy --------------------------------------------------

    def create(
        self,
        name: str,
        *,
        width: int,
        height: int,
        adaptive: bool = False,
        still_after: float | None = None,
        stats_interval: float | None = None,
        encode_pipeline_depth: int = 0,
        resize_policy: str = "publisher",
        max_render_dimension: int | None = None,
        private: bool = False,
    ) -> Any:
        """Register a stream on the hub, seed its scene, and start its publish task."""
        width, height = _even(width), _even(height)
        display = self.server.add_stream(
            name,
            width,
            height,
            fps=self.fps,
            bitrate=self.bitrate,
            adaptive=adaptive,
            still_after=still_after,
            stats_interval=self.stats_interval if stats_interval is None else stats_interval,
            encode_pipeline_depth=encode_pipeline_depth,
            resize_policy=resize_policy,
            max_render_dimension=max_render_dimension,
        )
        host = self.server._streams[name]
        state = _DemoState(self._first_scene(), width, height)
        self.states[name] = state
        self.tasks[name] = asyncio.create_task(_render_loop(display, state, host))
        log.info(
            "stream %r created: %dx%d scene=%s adaptive=%s still_after=%s resize=%s private=%s",
            name,
            width,
            height,
            state.active_key,
            adaptive,
            still_after,
            resize_policy,
            private,
        )
        return display

    def create_private(self, body: dict[str, Any]) -> str:
        """Mint a new private stream from a create-request body; returns its name.

        Raises :class:`RuntimeError` when the private-stream cap is reached.
        """
        private = [n for n in self.states if n != DEFAULT_STREAM]
        if len(private) >= self.private_cap:
            raise RuntimeError(f"private stream cap reached ({self.private_cap})")
        self._private_seq += 1
        name = f"s{self._private_seq}"
        dw, dh = self.default_size
        self.create(
            name,
            width=int(body.get("width", dw)),
            height=int(body.get("height", dh)),
            adaptive=bool(body.get("adaptive", False)),
            still_after=_opt_float(body.get("still_after")),
            stats_interval=_opt_float(body.get("stats_interval"), default=self.stats_interval),
            encode_pipeline_depth=int(body.get("encode_pipeline_depth", 0)),
            resize_policy=str(body.get("resize_policy", "publisher")),
            max_render_dimension=_opt_int(body.get("max_render_dimension")),
            private=True,
        )
        return name

    async def destroy(self, name: str) -> None:
        """Cancel a private stream's publish task and remove it from the hub."""
        if name == DEFAULT_STREAM:
            raise ValueError("cannot destroy the default stream")
        task = self.tasks.pop(name, None)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self.states.pop(name, None)
        self._empty_since.pop(name, None)
        self.server.remove_stream(name)
        log.info("stream %r destroyed", name)

    # --- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        dw, dh = self.default_size
        self.create(DEFAULT_STREAM, width=dw, height=dh, stats_interval=self.stats_interval, private=False)
        self._reaper = asyncio.create_task(self._reap_loop())

    async def aclose(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reaper
            self._reaper = None
        for name in list(self.tasks):
            task = self.tasks.pop(name)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _reap_loop(self) -> None:
        """Destroy private streams that have had no viewers for ``reap_grace`` seconds."""
        while True:
            await asyncio.sleep(2.0)
            now = time.monotonic()
            for name in [n for n in self.states if n != DEFAULT_STREAM]:
                host = self.server._streams.get(name)
                if host is None:
                    continue
                if host.display.client_count == 0:
                    self._empty_since.setdefault(name, now)
                    if now - self._empty_since[name] >= self.reap_grace:
                        with contextlib.suppress(Exception):
                            await self.destroy(name)
                else:
                    self._empty_since.pop(name, None)

    # --- state reporting ---------------------------------------------------

    def stream_state(self, name: str) -> dict[str, Any]:
        host = self.server._streams[name]
        d = host.display
        st = self.states[name]
        return {
            "name": name,
            "ws": f"/rfb/{name}",
            "private": name != DEFAULT_STREAM,
            "clients": d.client_count,
            "scene": st.active_key,
            "backend": _current_backend(host),
            "bitrate": host.bitrate,
            "bitrate_label": _fmt_bitrate(host.bitrate),
            "fps": host.fps,
            "width": d.width,
            "height": d.height,
            "color": st.color or "srgb",
            "adaptive": host.adaptive,
            "still_after": host.still_after,
            "stats_interval": host.stats_interval,
            "encode_pipeline_depth": host.encode_pipeline_depth,
            "resize_policy": d.resize_policy,
            "max_render_dimension": d.max_render_dimension,
            "last_error": st.last_error,
        }

    def state(self) -> dict[str, Any]:
        return {"streams": [self.stream_state(n) for n in self.states]}


def _opt_float(v: Any, default: float | None = None) -> float | None:
    if v is None or v == "":
        return default
    try:
        return float(v)
    except TypeError, ValueError:
        return default


def _opt_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except TypeError, ValueError:
        return None


# --- the ASGI app -----------------------------------------------------------


def build_demo_app(
    *,
    width: int = 1280,
    height: int = 720,
    fps: int = 30,
    bitrate: int | str = "8M",
    stats_interval: float | None = 1.0,
    static_dir: str | Path | None = STATIC_DEMO_DIR,
    private_cap: int = 8,
) -> Any:
    """Build the demo's Starlette app: REST control + framebuffer WS + the static SPA.

    The hub's ``websockets`` listener is intentionally never started — connections are
    driven through :func:`~pdum.rfb.asgi.rfb_hub_endpoint`, so everything shares one
    uvicorn origin. If ``static_dir`` is missing (SPA not built yet) a placeholder page is
    served so the control plane is still exercisable.
    """
    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import HTMLResponse, JSONResponse, Response
    from starlette.routing import Mount, Route, WebSocketRoute
    from starlette.staticfiles import StaticFiles

    from .asgi import rfb_hub_endpoint

    server = Server(host="127.0.0.1", port=0)  # port unused: no listener is started
    manager = DemoStreamManager(
        server,
        default_width=width,
        default_height=height,
        fps=fps,
        bitrate=_parse_bitrate(bitrate),
        stats_interval=stats_interval,
        private_cap=private_cap,
    )

    @contextlib.asynccontextmanager
    async def lifespan(app: Any):
        await manager.start()
        log.info("demo ready — %d scene(s), %d backend(s) available", len(available_demos()), len(available_backends()))
        try:
            yield
        finally:
            await manager.aclose()
            await server.aclose()

    def _host_or_404(name: str):
        host = server._streams.get(name)
        if host is None:
            return None
        return host

    async def caps_route(request: Request) -> JSONResponse:
        return JSONResponse(capabilities())

    async def state_route(request: Request) -> JSONResponse:
        return JSONResponse(manager.state())

    async def create_stream(request: Request) -> JSONResponse:
        body = await _json(request)
        try:
            name = manager.create_private(body)
        except RuntimeError as exc:
            return JSONResponse({"error": str(exc)}, status_code=429)
        return JSONResponse(manager.stream_state(name), status_code=201)

    async def delete_stream(request: Request) -> Response:
        name = request.path_params["name"]
        if name == DEFAULT_STREAM:
            return JSONResponse({"error": "cannot destroy the default stream"}, status_code=400)
        if name not in manager.states:
            return JSONResponse({"error": f"unknown stream {name!r}"}, status_code=404)
        await manager.destroy(name)
        return JSONResponse({"ok": True})

    async def set_scene(request: Request) -> JSONResponse:
        name = request.path_params["name"]
        host = _host_or_404(name)
        if host is None:
            return JSONResponse({"error": f"unknown stream {name!r}"}, status_code=404)
        body = await _json(request)
        key = body.get("key")
        try:
            manager.states[name].select(key)
        except KeyError:
            return JSONResponse({"error": f"unknown scene {key!r}"}, status_code=400)
        log.info("stream %r → scene %s", name, key)
        return JSONResponse(manager.stream_state(name))

    async def set_backend(request: Request) -> JSONResponse:
        name = request.path_params["name"]
        host = _host_or_404(name)
        if host is None:
            return JSONResponse({"error": f"unknown stream {name!r}"}, status_code=404)
        body = await _json(request)
        bid = body.get("id", "")
        if bid not in {b["id"] for b in backend_catalog()}:
            return JSONResponse({"error": f"unknown backend {bid!r}"}, status_code=400)
        try:
            host.switch_backend(bid)
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"error": f"backend switch failed: {exc}"}, status_code=400)
        log.info("stream %r → backend %s", name, bid)
        return JSONResponse(manager.stream_state(name))

    async def set_quality(request: Request) -> JSONResponse:
        name = request.path_params["name"]
        host = _host_or_404(name)
        if host is None:
            return JSONResponse({"error": f"unknown stream {name!r}"}, status_code=404)
        body = await _json(request)
        br = _parse_bitrate(body["bitrate"]) if body.get("bitrate") not in (None, "") else None
        fps = int(body["fps"]) if body.get("fps") not in (None, "") else None
        host.set_quality(bitrate=br, fps=fps)
        log.info("stream %r → quality bitrate=%s fps=%s", name, br, fps)
        return JSONResponse(manager.stream_state(name))

    async def set_params(request: Request) -> JSONResponse:
        """Apply the *live* stream params (resolution + color). Structural params are fixed
        at creation and are rejected here with a hint to make a private stream."""
        name = request.path_params["name"]
        host = _host_or_404(name)
        if host is None:
            return JSONResponse({"error": f"unknown stream {name!r}"}, status_code=404)
        body = await _json(request)
        st = manager.states[name]
        structural = {
            "adaptive",
            "still_after",
            "stats_interval",
            "encode_pipeline_depth",
            "resize_policy",
            "max_render_dimension",
        }
        rejected = structural & set(body)
        if rejected:
            return JSONResponse(
                {"error": f"structural params {sorted(rejected)} are set at stream creation — make a private stream"},
                status_code=409,
            )
        if "width" in body:
            st.width = _even(body["width"])
        if "height" in body:
            st.height = _even(body["height"])
        if "color" in body:
            st.color = body["color"] or None
        log.info("stream %r → params w=%s h=%s color=%s", name, st.width, st.height, st.color)
        return JSONResponse(manager.stream_state(name))

    async def metrics_route(request: Request) -> JSONResponse:
        host = _host_or_404(request.path_params["name"])
        if host is None:
            return JSONResponse([], status_code=404)
        return JSONResponse(host.metrics())

    async def placeholder(request: Request) -> HTMLResponse:
        return HTMLResponse(_PLACEHOLDER_HTML, status_code=200)

    routes: list[Any] = [
        Route("/demo/capabilities", caps_route),
        Route("/demo/state", state_route),
        Route("/demo/streams", create_stream, methods=["POST"]),
        Route("/demo/streams/{name}", delete_stream, methods=["DELETE"]),
        Route("/demo/streams/{name}/scene", set_scene, methods=["POST"]),
        Route("/demo/streams/{name}/backend", set_backend, methods=["POST"]),
        Route("/demo/streams/{name}/quality", set_quality, methods=["POST"]),
        Route("/demo/streams/{name}/params", set_params, methods=["POST"]),
        Route("/streams/{name}/metrics", metrics_route),
        WebSocketRoute("/rfb/{stream}", rfb_hub_endpoint(server)),
    ]
    sd = Path(static_dir) if static_dir else None
    if sd is not None and sd.is_dir():
        routes.append(Mount("/", app=StaticFiles(directory=str(sd), html=True)))
    else:
        routes.append(Route("/", placeholder))
        routes.append(Route("/{path:path}", placeholder))

    app = Starlette(lifespan=lifespan, routes=routes)
    app.state.manager = manager  # test hook
    app.state.server = server
    return app


async def _json(request: Any) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


_PLACEHOLDER_HTML = """<!doctype html><meta charset=utf-8>
<title>pdum-rfb demo</title>
<body style="font-family:Georgia,serif;background:#faf9f7;color:#2c2c2c;max-width:34rem;margin:4rem auto">
<h1 style="font-weight:400">pdum-rfb demo</h1>
<p>The control plane is running, but the web UI bundle has not been built yet.</p>
<pre style="background:#fff;border:1px solid #c0b9ad;padding:1rem">pnpm -C widgets install
pnpm -C widgets build:demo</pre>
<p style="color:#6b6560">REST is live: <code>GET /demo/capabilities</code>, <code>GET /demo/state</code>,
and the framebuffer WebSocket at <code>/rfb/default</code>.</p>
</body>"""


# --- run (uvicorn) ----------------------------------------------------------


def _free_port(host: str) -> int:
    """Pick an available TCP port (bind :0, read it back). Tiny TOCTOU race — fine for a dev tool."""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def _open_browser_when_ready(url: str, host: str, port: int, timeout: float = 20.0) -> None:
    """Open the default browser at ``url`` once ``host:port`` accepts connections (background thread)."""
    import socket
    import threading
    import time
    import webbrowser

    def _wait() -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((host, port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.2)
        with contextlib.suppress(Exception):
            webbrowser.open(url)

    threading.Thread(target=_wait, daemon=True).start()


def _repo_root() -> Path:
    """The repo root (…/src/pdum/rfb/demo_server.py → repo). Only meaningful in a dev checkout."""
    return Path(__file__).resolve().parents[3]


def make_dev_app() -> Any:
    """App factory for ``pdum-rfb demo --dev`` — uvicorn ``reload=True`` re-imports this on every
    Python change, so config is read from env (it survives the reload subprocess). API-only: in
    dev the SPA is served by Vite (with HMR), which proxies REST + WS back to this process."""
    import os

    return build_demo_app(
        width=int(os.environ.get("RFB_DEMO_W", "1280")),
        height=int(os.environ.get("RFB_DEMO_H", "720")),
        fps=int(os.environ.get("RFB_DEMO_FPS", "30")),
        bitrate=os.environ.get("RFB_DEMO_BITRATE", "8M"),
        static_dir=None,
    )


def _run_static(host: str, port: int, w: int, h: int, fps: int, bitrate: int | str, open_browser: bool) -> None:
    """The default path: serve the prebuilt SPA + REST + WS from one uvicorn process (blocking)."""
    import uvicorn

    app = build_demo_app(width=w, height=h, fps=fps, bitrate=bitrate)
    built = STATIC_DEMO_DIR.is_dir()
    url = f"http://{host}:{port}/"
    spa = "built" if built else "NOT BUILT — run `pnpm -C widgets build:demo`"
    log.info("pdum-rfb demo ▶ %s   (SPA: %s)", url, spa)
    if open_browser:
        _open_browser_when_ready(url, host, port)
    uvicorn.run(app, host=host, port=port, log_level="warning")


def _run_dev(host: str, api_port: int, w: int, h: int, fps: int, bitrate: int | str, open_browser: bool) -> None:
    """Live-reload dev/agentic mode: Vite dev server (TS HMR) for the SPA, proxying REST + WS to a
    uvicorn process run with ``reload=True`` (Python HMR). Needs the repo checkout + Node."""
    import os
    import subprocess

    import uvicorn

    demo_dir = _repo_root() / "widgets" / "packages" / "demo-app"
    if not (demo_dir / "package.json").exists():
        log.warning("dev mode unavailable (widgets/packages/demo-app not found) — serving the prebuilt SPA instead")
        _run_static(host, api_port, w, h, fps, bitrate, open_browser)
        return

    vite_port = _free_port(host)
    env = dict(os.environ, RFB_DEMO_API=f"http://{host}:{api_port}")
    vite = subprocess.Popen(
        ["pnpm", "dev", "--host", host, "--port", str(vite_port), "--strictPort"],
        cwd=str(demo_dir),
        env=env,
    )
    url = f"http://{host}:{vite_port}/"
    log.info("pdum-rfb demo ▶ DEV %s", url)
    log.info("  Vite HMR (TS) + uvicorn reload (Python); REST+WS proxied to http://%s:%d", host, api_port)
    if open_browser:
        _open_browser_when_ready(url, host, vite_port)
    # Config for the reloadable API factory — env so it survives uvicorn's reload subprocess.
    os.environ.update(RFB_DEMO_W=str(w), RFB_DEMO_H=str(h), RFB_DEMO_FPS=str(fps), RFB_DEMO_BITRATE=str(bitrate))
    try:
        uvicorn.run(
            "pdum.rfb.demo_server:make_dev_app",
            factory=True,
            reload=True,
            reload_dirs=[str(_repo_root() / "src" / "pdum")],
            host=host,
            port=api_port,
            log_level="warning",
        )
    finally:
        with contextlib.suppress(Exception):
            vite.terminate()


def run_demo(
    *,
    width: int = 1280,
    height: int = 720,
    host: str = "127.0.0.1",
    port: int = 0,
    fps: int = 30,
    bitrate: int | str = "8M",
    verbose: bool = False,
    open_browser: bool = True,
    dev: bool = False,
) -> None:
    """Serve the demo web app (blocking). Localhost-only by default; ``port=0`` picks a free one.

    ``open_browser`` launches the browser at the URL once it's up; ``dev`` runs the live-reload
    agentic mode (Vite HMR + uvicorn reload) — see :func:`_run_dev`.
    """
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    w, h = _even(width), _even(height)
    api_port = _free_port(host) if port == 0 else port
    if dev:
        _run_dev(host, api_port, w, h, fps, bitrate, open_browser)
    else:
        _run_static(host, api_port, w, h, fps, bitrate, open_browser)


# --- headless self-test (Starlette TestClient, in-process) ------------------

_ALL_CAPS = ["webcodecs/h264-annexb", "image/jpeg", "image/png", "image/webp"]


def smoke(*, width: int = 320, height: int = 240, fps: int = 30, verbose: bool = True) -> dict:
    """Drive the real ASGI demo in-process: capabilities, every backend over REST on one
    socket, a 2-viewer fan-out check, and a private-stream create→connect→destroy cycle.

    Uses Starlette's ``TestClient`` (no uvicorn, no real port, no browser). Returns a
    result dict; raises ``AssertionError`` on any failure. This is the CI-grade proof.
    """
    from starlette.testclient import TestClient

    from .protocol import unpack_binary_message
    from .testing import decode_annexb

    def _log(msg: str) -> None:
        if verbose:
            print(f"[demo smoke] {msg}")

    w, h = _even(width), _even(height)
    app = build_demo_app(width=w, height=h, fps=fps, bitrate="4M", static_dir=None)
    results: dict[str, Any] = {"backends": {}}

    def _drain_until(ws: Any, want_kind: str, budget: int = 240) -> dict:
        for _ in range(budget):
            msg = ws.receive()
            if msg.get("type") == "websocket.close":
                raise AssertionError("socket closed while draining")
            data = msg.get("bytes")
            if data is None:
                continue
            header, payload = unpack_binary_message(data)
            ws.send_json({"type": "ack", "seq": header["seq"], "decode_queue_size": 0})
            kind = "video" if header["type"] == "video_chunk" else "image"
            if kind == want_kind:
                return {"header": header, "payload": payload}
        raise AssertionError(f"never saw a {want_kind} frame")

    with TestClient(app) as client:
        caps = client.get("/demo/capabilities").json()
        backends = [b for b in caps["backends"] if b["available"]]
        _log(f"scenes: {[s['key'] for s in caps['scenes'] if s['available']]}")
        _log(f"backends: {[b['id'] for b in backends]}")
        results["scenes"] = [s["key"] for s in caps["scenes"] if s["available"]]

        with client.websocket_connect("/rfb/default") as ws:
            ws.send_json({"type": "hello", "supported": _ALL_CAPS, "device_pixel_ratio": 1})
            config = ws.receive_json()
            assert config["type"] == "config", config
            _log(f"connected; initial transport={config['transport']}")

            for b in backends:
                bid = b["id"]
                want = "image" if bid.startswith("image:") else "video"
                r = client.post("/demo/streams/default/backend", json={"id": bid})
                assert r.status_code == 200, r.text
                got = _drain_until(ws, want)
                header, payload = got["header"], got["payload"]
                assert header["width"] == w and header["height"] == h, header
                if want == "video":
                    decode_annexb(payload)  # must not raise
                    detail = f"codec={header.get('codec')} bytes={len(payload)}"
                else:
                    from io import BytesIO

                    from PIL import Image

                    img = Image.open(BytesIO(payload))
                    img.load()
                    assert (img.width, img.height) == (w, h)
                    detail = f"mime={header.get('mime')} {img.width}x{img.height}"
                results["backends"][bid] = detail
                _log(f"  ✓ {bid}: {detail}")

            # Live retune over REST.
            assert client.post("/demo/streams/default/quality", json={"bitrate": "2M", "fps": 20}).status_code == 200
            _drain_until(ws, "image" if backends[-1]["id"].startswith("image:") else "video")
            _log("  ✓ REST quality retune — stream continued")

            # Scene switch + input round-trip on the paint demo.
            if any(s["key"] == "paint" for s in caps["scenes"]):
                assert client.post("/demo/streams/default/scene", json={"key": "paint"}).status_code == 200
                ws.send_json({"type": "event", "event": {"type": "pointer_down", "x": 5, "y": 5, "buttons": [1]}})
                _drain_until(ws, "image" if backends[-1]["id"].startswith("image:") else "video")
                results["scene_switch"] = True
                _log("  ✓ REST scene switch → paint + pointer event")

            # Multi-client fan-out: a second viewer on the same shared stream.
            with client.websocket_connect("/rfb/default") as ws2:
                ws2.send_json({"type": "hello", "supported": _ALL_CAPS, "device_pixel_ratio": 1})
                assert ws2.receive_json()["type"] == "config"
                _drain_until(ws2, "image" if backends[-1]["id"].startswith("image:") else "video")
                assert app.state.manager.stream_state("default")["clients"] >= 2
                results["fanout"] = True
                _log("  ✓ 2-viewer fan-out on the shared stream")

        # Private stream: create → connect → destroy.
        created = client.post("/demo/streams", json={"width": w, "height": h})
        assert created.status_code == 201, created.text
        pname = created.json()["name"]
        client.post(f"/demo/streams/{pname}/backend", json={"id": "image:jpeg"})  # deterministic
        with client.websocket_connect(f"/rfb/{pname}") as pws:
            pws.send_json({"type": "hello", "supported": _ALL_CAPS, "device_pixel_ratio": 1})
            assert pws.receive_json()["type"] == "config"
            _drain_until(pws, "image")  # default backend on a fresh private stream is image/auto
        assert client.delete(f"/demo/streams/{pname}").status_code == 200
        assert pname not in app.state.manager.states
        results["private_stream"] = pname
        _log(f"  ✓ private stream {pname} create → connect → destroy")

    _log("ALL GREEN")
    results["ok"] = True
    return results
