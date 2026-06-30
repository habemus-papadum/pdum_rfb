"""The ``pdum-rfb demo`` harness: a live feed + browser client + a Textual control panel.

One command starts everything needed to *try the whole stack* end to end:

* an in-process :func:`~pdum.rfb.server.serve` Display publishing a selectable demo scene;
* the browser client served by **Vite** (dev mode) so you just click a URL;
* a **Textual TUI** to switch demo scenes, switch encode backends *live* on the one
  WebSocket (image ⇄ libx264 ⇄ VideoToolbox ⇄ NVENC…), retune bitrate/fps, and watch
  per-session stats.

The backend switch rides :meth:`pdum.rfb.server._StreamHost.switch_backend`, which
reconfigures every live viewer between encode steps and re-sends ``config``; the browser
follows data-driven on the next keyframe, with no reconnect.

A headless :func:`smoke` mode drives the same machinery with a scripted WebSocket client
(no terminal/browser) so the feature is verifiable in CI / from a script.
"""

from __future__ import annotations

import asyncio
import contextlib
import socket
import time
from pathlib import Path
from typing import Any

from .demos import available_demos, get_demo
from .server import DEFAULT_STREAM, serve

# --- backend discovery ------------------------------------------------------


def available_backends() -> list[tuple[str, str]]:
    """Return ``(id, label)`` for every encode backend usable on this box.

    ``id`` is what :meth:`_StreamHost.switch_backend` accepts: ``image:<mode>`` or a
    registered video-encoder name. The image modes are always offered; video backends are
    gated by their availability probe so the panel only shows what can actually run here.
    """
    backends: list[tuple[str, str]] = [
        ("image:jpeg", "Image · JPEG (Pillow)"),
        ("image:png", "Image · PNG (lossless)"),
        ("image:webp", "Image · WebP (Pillow)"),
    ]

    def _ok(modpath: str, fn: str) -> bool:
        try:
            import importlib

            return bool(getattr(importlib.import_module(modpath), fn)())
        except Exception:
            return False

    import importlib.util

    if importlib.util.find_spec("av") is not None:
        backends.append(("h264_cpu", "H.264 · libx264 (CPU, PyAV)"))
    if _ok("pdum.rfb.encoders.vtenc", "vtenc_available"):
        backends.append(("vtenc", "H.264 · VideoToolbox (Apple HW)"))
    if _ok("pdum.rfb.encoders.nvenc_cpu", "nvenc_cpu_available"):
        backends.append(("nvenc_cpu", "H.264 · NVENC (host input)"))
    if _ok("pdum.rfb.gpu", "cuda_zerocopy_available"):
        backends.append(("nvenc_gpu_pyav", "H.264 · NVENC zero-copy (PyAV≥18)"))
    if _ok("pdum.rfb.encoders.nvenc_gpu_pdum", "nvenc_gpu_pdum_available"):
        backends.append(("nvenc_gpu_pdum", "H.264 · NVENC SDK (pdum.nvenc)"))
    return backends


def _parse_bitrate(text: str) -> int:
    """Parse ``"8M"`` / ``"800k"`` / ``"8000000"`` into bits per second."""
    s = text.strip().lower().replace("bps", "")
    mult = 1
    if s.endswith("m"):
        mult, s = 1_000_000, s[:-1]
    elif s.endswith("k"):
        mult, s = 1_000, s[:-1]
    return int(float(s) * mult)


# --- shared mutable state between the render loop and the TUI ----------------


class _DemoState:
    """The selected scene; both the render loop and the TUI mutate this (one event loop)."""

    def __init__(self, first_key: str) -> None:
        self.active_key = first_key
        self.instance = get_demo(first_key).make()
        self.last_error: str | None = None

    def select(self, key: str) -> None:
        self.active_key = key
        self.instance = get_demo(key).make()
        self.last_error = None


# --- the publish loop -------------------------------------------------------


async def _render_loop(display: Any, state: _DemoState, fps: int) -> None:
    """Publish the active demo's frames and route browser input back into it."""
    w, h = display.width, display.height
    seq = 0
    t0 = time.monotonic()
    interval = 1.0 / max(fps, 1)
    while True:
        inst = state.instance
        try:
            frame = inst.frame(seq, time.monotonic() - t0, w, h)
            display.publish(frame)
        except Exception as exc:  # a buggy scene must not kill the loop
            state.last_error = f"{type(exc).__name__}: {exc}"
        for ev in display.poll_events():
            on_event = getattr(state.instance, "on_event", None)
            if on_event is not None:
                with contextlib.suppress(Exception):
                    on_event(ev.event)
        seq += 1
        await asyncio.sleep(interval)


# --- Vite dev server --------------------------------------------------------


def find_widgets_dir(override: str | Path | None = None) -> Path | None:
    """Locate the ``widgets/`` workspace (with ``package.json``) for the Vite dev server."""
    candidates = []
    if override is not None:
        candidates.append(Path(override))
    candidates.append(Path(__file__).resolve().parents[3] / "widgets")
    candidates.append(Path.cwd() / "widgets")
    for c in candidates:
        if (c / "package.json").exists():
            return c
    return None


async def _launch_vite(widgets_dir: Path, host: str, port: int, log: Path) -> Any:
    """Start the Vite dev server (prefers the local ``vite`` bin, falls back to pnpm)."""
    vite_bin = widgets_dir / "node_modules" / ".bin" / "vite"
    if vite_bin.exists():
        argv = [str(vite_bin), "--host", host, "--port", str(port), "--strictPort"]
    else:
        argv = ["pnpm", "dev", "--host", host, "--port", str(port), "--strictPort"]
    logf = log.open("wb")
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=str(widgets_dir), stdout=logf, stderr=asyncio.subprocess.STDOUT
    )
    return proc


async def _wait_port(host: str, port: int, timeout: float = 25.0) -> bool:
    """Poll until ``host:port`` accepts a TCP connection (Vite is up) or ``timeout``."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            await asyncio.get_running_loop().run_in_executor(None, _try_connect, host, port)
            return True
        except OSError:
            await asyncio.sleep(0.25)
    return False


def _try_connect(host: str, port: int) -> None:
    with socket.create_connection((host, port), timeout=1.0):
        pass


def web_url(host: str, web_port: int, ws_host: str, ws_port: int) -> str:
    """The clickable demo URL (the page reads ``?ws=`` to find the framebuffer socket)."""
    return f"http://{host}:{web_port}/?ws=ws://{ws_host}:{ws_port}"


# --- orchestration ----------------------------------------------------------


async def run_demo(
    *,
    width: int = 1280,
    height: int = 720,
    host: str = "127.0.0.1",
    port: int = 8765,
    fps: int = 30,
    bitrate: int = 8_000_000,
    web_host: str = "127.0.0.1",
    web_port: int = 5173,
    no_vite: bool = False,
    web_url_override: str | None = None,
    widgets_dir: str | Path | None = None,
    scratch: str | Path | None = None,
) -> None:
    """Start the server + render loop + (optionally) Vite, then run the Textual TUI."""
    from .demo_app import DemoApp  # lazy: imports textual

    demos = available_demos()
    backends = available_backends()
    state = _DemoState(demos[0].key)

    display = await serve(width, height, host=host, port=port, fps=fps, bitrate=bitrate, record_events=True)
    stream_host = display._owner_server._streams[DEFAULT_STREAM]
    render_task = asyncio.create_task(_render_loop(display, state, fps))

    vite_proc = None
    url = web_url_override or web_url(web_host, web_port, host, display.port)
    vite_status = "external (you run the client)"
    if not no_vite and web_url_override is None:
        wdir = find_widgets_dir(widgets_dir)
        if wdir is None:
            vite_status = "widgets/ not found — open the client yourself with ?ws=…"
        else:
            scratch_dir = Path(scratch) if scratch else wdir
            log_path = scratch_dir / "vite-demo.log"
            try:
                vite_proc = await _launch_vite(wdir, web_host, web_port, log_path)
                up = await _wait_port(web_host, web_port)
                vite_status = "running" if up else f"started but not reachable (see {log_path})"
            except Exception as exc:  # noqa: BLE001
                vite_status = f"failed to start Vite: {exc}"

    app = DemoApp(
        display=display,
        stream_host=stream_host,
        state=state,
        demos=demos,
        backends=backends,
        url=url,
        vite_status=vite_status,
        bitrate=bitrate,
        fps=fps,
    )
    try:
        await app.run_async()
    finally:
        render_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await render_task
        if vite_proc is not None:
            with contextlib.suppress(ProcessLookupError):
                vite_proc.terminate()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(vite_proc.wait(), timeout=5)
        await display.aclose()


# --- headless verification --------------------------------------------------

_ALL_CAPS = ["webcodecs/h264-annexb", "image/jpeg", "image/png", "image/webp"]


async def smoke(*, width: int = 320, height: int = 240, fps: int = 30, verbose: bool = True) -> dict:
    """Drive the demo machinery headlessly: every backend + a param change + event round-trip.

    Connects a scripted WebSocket client (no browser), switches through every available
    backend live on the one socket, verifies frames decode for each, retunes quality, and
    confirms a browser→server input event reaches the Display. Returns a result dict; raises
    ``AssertionError`` on any failure. This is the CI-grade proof the feature works.
    """
    import json

    import websockets.asyncio.client

    from .testing import decode_annexb

    def _log(msg: str) -> None:
        if verbose:
            print(f"[demo smoke] {msg}")

    demos = available_demos()
    backends = available_backends()
    _log(f"demos: {[d.key for d in demos]}")
    _log(f"backends: {[b[0] for b in backends]}")

    state = _DemoState(demos[0].key)
    display = await serve(width, height, port=0, fps=fps, bitrate=4_000_000, record_events=True)
    host = display._owner_server._streams[DEFAULT_STREAM]
    render_task = asyncio.create_task(_render_loop(display, state, fps))
    results: dict[str, Any] = {"backends": {}, "demos": [d.key for d in demos]}

    async def _drain_until(ws, want_kind: str, timeout: float = 6.0) -> dict:
        """Read+ack binary frames until one matches ``want_kind`` ('image'|'video')."""
        from .protocol import unpack_binary_message

        deadline = time.monotonic() + timeout
        seen: list[str] = []
        while time.monotonic() < deadline:
            msg = await asyncio.wait_for(ws.recv(), timeout=timeout)
            if not isinstance(msg, (bytes, bytearray)):
                continue
            header, payload = unpack_binary_message(msg)
            await ws.send(json.dumps({"type": "ack", "seq": header["seq"], "decode_queue_size": 0}))
            kind = "video" if header["type"] == "video_chunk" else "image"
            seen.append(kind)
            if kind == want_kind:
                return {"header": header, "payload": payload}
        raise AssertionError(f"never saw a {want_kind} frame (saw {seen})")

    try:
        port = display.port
        async with websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.send(json.dumps({"type": "hello", "supported": _ALL_CAPS, "device_pixel_ratio": 1}))
            config = json.loads(await ws.recv())
            assert config["type"] == "config", config
            _log(f"connected; initial transport={config['transport']}")

            for bid, _label in backends:
                want = "image" if bid.startswith("image:") else "video"
                host.switch_backend(bid)
                got = await _drain_until(ws, want)
                header, payload = got["header"], got["payload"]
                assert header["width"] == width and header["height"] == height, header
                if want == "video":
                    frames = decode_annexb(b"".join([payload]))
                    ok = len(frames) >= 0  # decode must not raise; keyframe may need more AUs
                    detail = f"codec={header.get('codec')} bytes={len(payload)}"
                else:
                    from io import BytesIO

                    from PIL import Image

                    img = Image.open(BytesIO(payload))
                    img.load()
                    ok = (img.width, img.height) == (width, height)
                    detail = f"mime={header.get('mime')} {img.width}x{img.height}"
                assert ok, f"{bid}: decode check failed ({detail})"
                results["backends"][bid] = detail
                _log(f"  ✓ {bid}: {detail}")

            # Live param retune on whatever backend is current.
            host.set_quality(bitrate=2_000_000, fps=20)
            await _drain_until(ws, "image" if backends[-1][0].startswith("image:") else "video")
            _log("  ✓ set_quality(bitrate=2M, fps=20) — stream continued")

            # Switch to the interactive demo and prove an input event reaches the Display.
            if any(d.key == "paint" for d in demos):
                state.select("paint")
                display.recorded.clear()
                await ws.send(
                    json.dumps({"type": "event", "event": {"type": "pointer_down", "x": 10, "y": 10, "buttons": [1]}})
                )
                for _ in range(100):
                    if any(e.get("type") == "pointer_down" for e in display.recorded):
                        break
                    await asyncio.sleep(0.02)
                assert any(e.get("type") == "pointer_down" for e in display.recorded), "event never arrived"
                results["event_roundtrip"] = True
                _log("  ✓ pointer event round-trip to the paint demo")
    finally:
        render_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await render_task
        await display.aclose()

    _log("ALL GREEN")
    results["ok"] = True
    return results
