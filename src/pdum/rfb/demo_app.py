"""The Textual control panel for ``pdum-rfb demo`` (imported lazily; needs ``[demo]``).

A two-column TUI: pick a **demo scene** and an **encode backend** from lists, retune
**bitrate/fps**, and watch **live per-session stats**. Selecting a scene swaps what the
render loop publishes; selecting a backend calls
:meth:`pdum.rfb.server._StreamHost.switch_backend`, which reconfigures every live viewer
on the same WebSocket (no reconnect).
"""

from __future__ import annotations

from typing import Any

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, Footer, Header, Input, OptionList, RichLog, Static
from textual.widgets.option_list import Option

from .demo_tui import _parse_bitrate


class DemoApp(App):
    """Drive a live framebuffer demo: switch scenes & encode backends, retune, watch stats."""

    CSS = """
    #cols { height: 1fr; }
    #left { width: 46%; padding: 0 1; }
    #right { width: 54%; padding: 0 1; }
    OptionList { height: auto; max-height: 12; border: round $primary; margin-bottom: 1; }
    #quality { height: auto; border: round $primary; padding: 0 1; margin-bottom: 1; }
    #quality Input { width: 18; }
    #url { border: round $accent; padding: 0 1; margin-bottom: 1; color: $text; }
    #stats { border: round $success; padding: 0 1; height: auto; margin-bottom: 1; }
    #log { border: round $warning; height: 1fr; }
    Button { margin: 0 1; }
    """

    BINDINGS = [("q", "quit", "Quit")]

    def __init__(
        self,
        *,
        display: Any,
        stream_host: Any,
        state: Any,
        demos: list[Any],
        backends: list[tuple[str, str]],
        url: str,
        vite_status: str,
        bitrate: int,
        fps: int,
    ) -> None:
        super().__init__()
        self.rfb_display = display
        self.rfb_host = stream_host
        self.state = state
        self.demos = demos
        self.backends = backends
        self.url = url
        self.vite_status = vite_status
        self.bitrate = bitrate
        self.fps = fps

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="cols"):
            with Vertical(id="left"):
                demo_list = OptionList(
                    *[Option(f"{d.name} — {d.description}", id=d.key) for d in self.demos], id="demos"
                )
                demo_list.border_title = "Demo scene"
                yield demo_list
                backend_list = OptionList(*[Option(label, id=bid) for bid, label in self.backends], id="backends")
                backend_list.border_title = "Encode backend (switches live)"
                yield backend_list
                with Vertical(id="quality"):
                    yield Static("Quality")
                    with Horizontal():
                        yield Input(value=_fmt_bitrate(self.bitrate), id="bitrate", placeholder="8M")
                        yield Input(value=str(self.fps), id="fps", placeholder="30")
                        yield Button("Apply", id="apply", variant="primary")
            with Vertical(id="right"):
                url = Static(
                    f"Open in your browser:\n[b link={self.url}]{self.url}[/]\nVite: {self.vite_status}", id="url"
                )
                url.border_title = "Browser client"
                stats = Static("", id="stats")
                stats.border_title = "Live stats"
                yield stats
                log = RichLog(id="log", markup=True, highlight=True)
                log.border_title = "Log"
                yield log
        yield Footer()

    def on_mount(self) -> None:
        self.title = "pdum-rfb demo"
        self.sub_title = self.url
        log = self.query_one("#log", RichLog)
        log.write(f"[b]Client URL:[/] {self.url}")
        log.write(f"[b]Vite:[/] {self.vite_status}")
        log.write(f"[b]WebSocket:[/] ws://{self.rfb_display.port and ''}…  (port {self.rfb_display.port})")
        log.write("Pick a [b]demo scene[/] and an [b]encode backend[/]; both apply live.")
        # Reflect the starting scene selection.
        self.query_one("#demos", OptionList).highlighted = 0
        self.set_interval(1.0, self._refresh_stats)
        self._refresh_stats()

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        which = event.option_list.id
        oid = event.option.id
        log = self.query_one("#log", RichLog)
        if which == "demos":
            self.state.select(oid)
            log.write(f"[cyan]scene →[/] {oid}")
        elif which == "backends":
            try:
                self.rfb_host.switch_backend(oid)
                log.write(f"[green]backend →[/] {oid} (live switch; browser follows on next keyframe)")
            except Exception as exc:  # noqa: BLE001
                log.write(f"[red]backend switch failed:[/] {exc}")
        self._refresh_stats()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id != "apply":
            return
        log = self.query_one("#log", RichLog)
        try:
            br = _parse_bitrate(self.query_one("#bitrate", Input).value)
            fps = int(self.query_one("#fps", Input).value)
            self.rfb_host.set_quality(bitrate=br, fps=fps)
            self.bitrate, self.fps = br, fps
            log.write(f"[green]quality →[/] bitrate={br / 1e6:.1f}M fps={fps} (encoders rebuilt)")
        except Exception as exc:  # noqa: BLE001
            log.write(f"[red]quality apply failed:[/] {exc}")
        self._refresh_stats()

    def _current_backend(self) -> str:
        h = self.rfb_host
        if h._force_transport == "image":
            return f"image:{h.image_mode}"
        if h._force_transport == "h264":
            return h.video_encoder
        return f"auto ({h.video_encoder})"

    def _refresh_stats(self) -> None:
        metrics = self.rfb_host.metrics()
        lines = [
            f"scene:    {self.state.active_key}",
            f"backend:  {self._current_backend()}",
            f"clients:  {self.rfb_display.client_count}",
        ]
        if self.state.last_error:
            lines.append(f"[red]scene error: {self.state.last_error}[/]")
        for i, m in enumerate(metrics):
            lines.append(
                f"  · c{i}: {m['fps_sent']:.1f} fps  {m['bitrate_bps'] / 1e6:.1f} Mbps  "
                f"enc {m['encode_ms']:.1f}ms  rtt {m['rtt_ms']:.0f}ms  "
                f"inflight {m['inflight']}  dropped {m['frames_dropped']}  q {m['decode_queue_size']}"
            )
        if not metrics:
            lines.append("  (no viewers connected yet — open the URL above)")
        self.query_one("#stats", Static).update("\n".join(lines))


def _fmt_bitrate(bps: int) -> str:
    return f"{bps / 1e6:.1f}M" if bps >= 1_000_000 else f"{bps // 1000}k"
