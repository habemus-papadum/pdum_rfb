"""``pdum-rfb`` command-line diagnostics.

Two commands, both optional (install with ``pip install habemus-papadum-rfb[cli]``):

* ``pdum-rfb doctor`` — probe this box and show, as a table, which encode paths
  work (image, CPU H.264, host NVENC, zero-copy CUDA→NVENC, NVENC SDK, and — on
  macOS/Apple Silicon — Apple VideoToolbox + MLX) and which one to prefer.
* ``pdum-rfb benchmark`` — measure per-frame encode latency / size / PSNR for every
  available path (a Rich-rendered wrapper over :mod:`pdum.rfb.benchmark`).

The module imports cleanly without Typer/Rich; the console-script entry point then
prints an install hint instead of crashing.
"""

from __future__ import annotations

import importlib
import platform
import sys
from dataclasses import dataclass

try:
    import typer
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table

    _HAVE_CLI = True
except ModuleNotFoundError:  # pragma: no cover - exercised only without the [cli] extra
    _HAVE_CLI = False


if not _HAVE_CLI:

    def app() -> None:  # type: ignore[misc]
        sys.stderr.write("The pdum-rfb CLI needs Typer + Rich.\n  pip install 'habemus-papadum-rfb[cli]'\n")
        raise SystemExit(1)

else:
    app = typer.Typer(
        add_completion=False,
        no_args_is_help=True,
        help="Diagnostics for pdum.rfb encode paths (doctor, benchmark).",
    )

    OK, WARN, MISSING = "ok", "warn", "missing"
    _STATUS_MARKUP = {
        OK: "[bold green]✓ ok[/]",
        WARN: "[bold yellow]△ partial[/]",
        MISSING: "[dim]– n/a[/]",
    }

    @dataclass(slots=True)
    class Probe:
        component: str
        status: str
        detail: str

    def _version(mod_name: str) -> str | None:
        try:
            mod = importlib.import_module(mod_name)
        except Exception:
            return None
        return getattr(mod, "__version__", "?")

    def _gpu_name() -> str | None:
        try:
            import cupy as cp

            return cp.cuda.runtime.getDeviceProperties(0)["name"].decode()
        except Exception:
            return None

    def _probe_all() -> tuple[list[Probe], str]:
        """Return (probes, recommended-path string)."""
        probes: list[Probe] = []

        # --- environment ---
        pyver = ".".join(map(str, sys.version_info[:3]))
        py_ok = sys.version_info[:2] >= (3, 14)
        probes.append(Probe("Python", OK if py_ok else WARN, f"{pyver} (need ≥3.14)"))
        mach = platform.machine()
        syst = platform.system()
        is_mac_arm = syst == "Darwin" and mach in ("arm64", "aarch64")
        plat_ok = (syst == "Linux" and mach in ("x86_64", "AMD64")) or is_mac_arm
        if is_mac_arm:
            plat_detail = f"{syst}/{mach}  (Apple Silicon: VideoToolbox HW H.264)"
        elif plat_ok:
            plat_detail = f"{syst}/{mach}"
        else:
            plat_detail = f"{syst}/{mach}  (HW encode: Linux/amd64 NVENC or macOS/arm64 VideoToolbox)"
        probes.append(Probe("Platform", OK if plat_ok else WARN, plat_detail))

        # --- core (always present) ---
        core = ", ".join(f"{m} {_version(m)}" for m in ("numpy", "PIL", "websockets") if _version(m))
        probes.append(Probe("Core (image path)", OK, core or "numpy/pillow/websockets"))

        # --- PyAV + libx264 (CPU H.264) ---
        av_ver = _version("av")
        x264 = False
        if av_ver:
            try:
                from .encoders.h264_cpu import h264_cpu_available

                x264 = h264_cpu_available()
            except Exception:
                x264 = False
            ge18 = tuple(int(p) for p in av_ver.split(".")[:1]) >= (18,)
            probes.append(Probe("PyAV", OK, f"{av_ver}" + ("  (≥18: zero-copy capable)" if ge18 else "")))
            probes.append(
                Probe(
                    "h264-cpu — CPU H.264 (libx264)",
                    OK if x264 else MISSING,
                    "libx264 present" if x264 else "no libx264",
                )
            )
        else:
            probes.append(Probe("PyAV", MISSING, "pip install 'habemus-papadum-rfb[h264]'"))
            probes.append(Probe("h264-cpu — CPU H.264 (libx264)", MISSING, "needs PyAV"))

        # --- GPU stack ---
        cupy_ver = _version("cupy")
        gpu_name = _gpu_name()
        probes.append(
            Probe(
                "CuPy",
                OK if cupy_ver else MISSING,
                f"{cupy_ver}" + (f"  ({gpu_name})" if gpu_name else "") if cupy_ver else "pip install cupy-cuda13x",
            )
        )

        host_nvenc = False
        try:
            from .encoders.nvenc_cpu import nvenc_cpu_available

            host_nvenc = nvenc_cpu_available()
        except Exception:
            pass
        probes.append(
            Probe(
                "nvenc-cpu — host NVENC (PyAV h264_nvenc)",
                OK if host_nvenc else MISSING,
                "available" if host_nvenc else "needs NVIDIA driver + NVENC GPU + PyAV",
            )
        )

        zerocopy = False
        try:
            from .gpu import cuda_zerocopy_available

            zerocopy = cuda_zerocopy_available()
        except Exception:
            pass
        probes.append(
            Probe(
                "nvenc-gpu-pyav — zero-copy CUDA→NVENC (PyAV≥18)",
                OK if zerocopy else MISSING,
                "available" if zerocopy else "needs CuPy + PyAV≥18 (see install docs)",
            )
        )

        sdk = False
        sdk_detail = "pip install habemus-papadum-nvenc (see install docs)"
        try:
            import pdum.nvenc  # noqa: F401

            sdk = _nvenc_gpu_pdum_selftest()
            sdk_detail = "available (no PyAV needed)" if sdk else "imported but self-test failed"
        except Exception:
            pass
        probes.append(Probe("nvenc-gpu-pdum — NVENC SDK (pdum.nvenc)", OK if sdk else MISSING, sdk_detail))

        # --- Apple VideoToolbox + MLX (macOS / Apple Silicon) ---
        not_mac = "macOS + Apple Silicon only"
        vt = False
        try:
            from .encoders.vtenc import vtenc_available

            vt = vtenc_available()
        except Exception:
            pass
        vt_detail = "available" if vt else "pip install 'habemus-papadum-rfb[mac-vt]'" if syst == "Darwin" else not_mac
        probes.append(Probe("vtenc — Apple VideoToolbox (H.264)", OK if vt else MISSING, vt_detail))
        mlx_ok = False
        try:
            from .metal import mlx_available

            mlx_ok = mlx_available()
        except Exception:
            pass
        mlx_detail = "available" if mlx_ok else "pip install mlx (the mac-dev group)" if syst == "Darwin" else not_mac
        probes.append(Probe("mlx — Apple Metal (GPU RGB→NV12)", OK if mlx_ok else MISSING, mlx_detail))

        # --- recommendation (fastest available, best first) ---
        if vt:
            rec = "vtenc — Apple VideoToolbox: hardware H.264 on macOS" + (
                " (with MLX for GPU RGB→NV12)" if mlx_ok else "; add MLX (mac-dev) for GPU color-convert"
            )
        elif sdk:
            rec = "nvenc-gpu-pdum — NVENC SDK (pdum.nvenc): fastest GPU path, no PyAV dependency"
        elif zerocopy:
            rec = "nvenc-gpu-pyav — zero-copy CUDA→NVENC (PyAV≥18): GPU encode, no host copy"
        elif host_nvenc:
            rec = "nvenc-cpu — host NVENC (PyAV h264_nvenc): GPU encode with a host upload"
        elif x264:
            rec = "h264-cpu — CPU H.264 (libx264 via PyAV): software, no GPU"
        else:
            rec = "image — JPEG/PNG/WebP: dependency-light, no H.264"
        return probes, rec

    def _nvenc_gpu_pdum_selftest(width: int = 256, height: int = 128) -> bool:
        try:
            import cupy as cp
            from pdum.nvenc import NvencEncoder

            enc = NvencEncoder(width, height, codec="h264", preset="p3", tuning="ll")
            nv12 = cp.zeros((height * 3 // 2, width), dtype=cp.uint8)
            cp.cuda.runtime.deviceSynchronize()
            enc.encode(nv12, force_idr=True)
            enc.flush()
            enc.close()
            return True
        except Exception:
            return False

    @app.command()
    def doctor() -> None:
        """Probe this box and report which encode paths work."""
        console = Console()
        probes, rec = _probe_all()
        table = Table(title="pdum.rfb — encode path doctor", title_style="bold")
        table.add_column("Component", style="cyan", no_wrap=True)
        table.add_column("Status", no_wrap=True)
        table.add_column("Detail")
        for p in probes:
            table.add_row(p.component, _STATUS_MARKUP.get(p.status, p.status), p.detail)
        console.print(table)
        console.print(Panel(f"[bold]Recommended:[/] {rec}", border_style="green", expand=False))
        # "✓ ok" means importable *in this environment*; a "– n/a"/"△" with a platform note
        # means the path is possible on this box once you install it. Run from a fresh env
        # with the cross-platform encoders present via the compound [doctor] extra:
        console.print(
            "[dim]✓ = available in this environment · notes show what this platform could run "
            "if installed.\n"
            "Fresh probe:  uvx --from 'habemus-papadum-rfb[doctor]' pdum-rfb doctor[/]"
        )

    @app.command()
    def benchmark(
        sizes: str = typer.Option("1280x720,1920x1080", help="comma-separated WxH"),
        frames: int = typer.Option(120, help="frames per configuration"),
        fps: int = typer.Option(30, help="target frame rate"),
        bitrate: str = typer.Option("8M", help="H.264/NVENC target bitrate, e.g. 8M"),
        pattern: str = typer.Option("gradient"),
        jpeg_quality: int = typer.Option(80, help="JPEG quality for the image row"),
        image: bool = typer.Option(True, help="include the image (JPEG) path"),
    ) -> None:
        """Benchmark every available encode path on this box (latency, size, PSNR)."""
        from . import benchmark as bench

        console = Console()
        br = bench._parse_bitrate(bitrate)

        # detect what's available
        from .encoders.h264_cpu import h264_cpu_available
        from .encoders.nvenc_cpu import NVENC_MIN_WIDTH, nvenc_cpu_available
        from .encoders.vtenc import VTENC_MIN_WIDTH

        have_h264 = h264_cpu_available()
        have_nvenc = nvenc_cpu_available()
        have_gpu = bench._cuda_zerocopy_available()
        have_sdk = bench._nvenc_gpu_pdum_available()
        have_vtenc = bench._vtenc_available()

        results = []
        with console.status("[bold]benchmarking…"):
            for size in sizes.split(","):
                w, h = bench._parse_size(size)
                if image:
                    results.append(
                        bench.benchmark_image(
                            mode="jpeg",
                            quality=jpeg_quality,
                            frames=frames,
                            width=w,
                            height=h,
                            fps=fps,
                            pattern=pattern,
                        )
                    )
                if have_h264:
                    results.append(
                        bench.benchmark_h264(bitrate=br, frames=frames, width=w, height=h, fps=fps, pattern=pattern)
                    )
                if have_nvenc and w >= NVENC_MIN_WIDTH:
                    results.append(
                        bench.benchmark_nvenc(bitrate=br, frames=frames, width=w, height=h, fps=fps, pattern=pattern)
                    )
                if have_gpu and w >= NVENC_MIN_WIDTH:
                    results.append(
                        bench.benchmark_nvenc_gpu_pyav(
                            bitrate=br, frames=frames, width=w, height=h, fps=fps, pattern=pattern
                        )
                    )
                if have_sdk and w >= NVENC_MIN_WIDTH:
                    results.append(
                        bench.benchmark_nvenc_gpu_pdum(
                            bitrate=br, frames=frames, width=w, height=h, fps=fps, pattern=pattern
                        )
                    )
                if have_vtenc and w >= VTENC_MIN_WIDTH:
                    results.append(
                        bench.benchmark_vtenc(bitrate=br, frames=frames, width=w, height=h, fps=fps, pattern=pattern)
                    )

        table = Table(title=f"pdum.rfb encoders — {pattern}, {frames} frames @ {fps}fps", title_style="bold")
        for col in ("config", "size", "enc ms", "p95 ms", "KB/frame", "Mbps@fps", "PSNR dB"):
            table.add_column(col, justify="right" if col != "config" else "left")
        for r in results:
            psnr = "inf" if r.psnr_db == float("inf") else f"{r.psnr_db:.2f}"
            style = "green" if r.encoder.startswith(("nvenc", "vtenc")) else None
            table.add_row(
                r.label,
                f"{r.width}x{r.height}",
                f"{r.encode_ms_mean:.2f}",
                f"{r.encode_ms_p95:.2f}",
                f"{r.bytes_per_frame / 1024:.1f}",
                f"{r.bitrate_at_fps_bps / 1e6:.2f}",
                psnr,
                style=style,
            )
        console.print(table)
        skipped = [
            n
            for n, ok in (
                ("h264-cpu", have_h264),
                ("nvenc-cpu", have_nvenc),
                ("nvenc-gpu-pyav", have_gpu),
                ("nvenc-gpu-pdum", have_sdk),
                ("vtenc", have_vtenc),
            )
            if not ok
        ]
        if skipped:
            console.print(f"[dim]skipped (unavailable): {', '.join(skipped)} — run `pdum-rfb doctor`[/]")

    @app.command()
    def demo(
        width: int = typer.Option(1280, help="framebuffer width (even)"),
        height: int = typer.Option(720, help="framebuffer height (even)"),
        port: int = typer.Option(8000, help="HTTP/WebSocket server port"),
        fps: int = typer.Option(30, help="publish frame rate"),
        bitrate: str = typer.Option("8M", help="initial H.264/NVENC bitrate, e.g. 8M"),
        host: str = typer.Option("127.0.0.1", help="bind host (default localhost-only)"),
        verbose: bool = typer.Option(False, "--verbose", "-v", help="DEBUG-level server logging"),
        smoke: bool = typer.Option(False, help="headless self-test: every backend + REST control, no browser"),
    ) -> None:
        """Interactive web demo: one process serves the app + controls; drive it in the browser.

        The control plane (scene / backend / quality / parameters) lives in the browser and
        rides REST; Python only serves the app and logs. Ships prebuilt — run it with uvx::

            uvx --from 'habemus-papadum-rfb[demo]' pdum-rfb demo
        """
        from . import demo_server

        w = width - (width % 2)
        h = height - (height % 2)
        if smoke:
            demo_server.smoke(width=w, height=h, fps=fps)
            return
        try:
            import uvicorn  # noqa: F401
        except ModuleNotFoundError:
            sys.stderr.write(
                "The demo needs Starlette + uvicorn.\n"
                "  uvx --from 'habemus-papadum-rfb[demo]' pdum-rfb demo\n"
                "  (or: pip install 'habemus-papadum-rfb[demo]')\n"
            )
            raise SystemExit(1) from None
        try:
            demo_server.run_demo(width=w, height=h, host=host, port=port, fps=fps, bitrate=bitrate, verbose=verbose)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    app()
