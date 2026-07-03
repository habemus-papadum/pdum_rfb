"""Server-side MP4 recording: tap the published-frame stream and mux to a file.

A convenience on :class:`~pdum.rfb.display.Display` (:meth:`Display.record`) that
records what you are *publishing* to a real **MP4** file, independent of any connected
browser — so it works fully headless (demos, CI artifacts, golden-frame capture).

Design notes (why this is not the wire path):

* It **reuses the H.264 encoder** (libx264) but muxes to a real MP4 container. This is
  the one place **AVCC-in-MP4** is correct — the wire invariant *"Annex B only, never
  route H.264 through an mp4 muxer"* is about the **WebSocket** payload; a file
  recording wants exactly the AVCC-in-MP4 the wire forbids. So this is a **separate**
  PyAV encode→mux pipeline (``av.open(..., "w")`` + ``add_stream("libx264")`` +
  ``container.mux``); it never touches the sessions' Annex B bitstream.
* It honors the **real monotonic timestamps** that already ride each
  :class:`~pdum.rfb.types.RawFrame`, so a variable-cadence publisher (sparse
  ``still_after`` scenes included) records with correct frame timing (VFR): each frame's
  PTS is its real timestamp relative to the first recorded frame.

PyAV is imported lazily (the ``[h264]`` extra), so ``import pdum.rfb`` — and even
``import pdum.rfb.recording`` — stays dependency-light.
"""

from __future__ import annotations

import asyncio
import importlib.util
from fractions import Fraction
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from .types import RawFrame

if TYPE_CHECKING:  # pragma: no cover
    from .display import Display

#: The recording stream's time base — microseconds — so a frame's PTS is exactly its
#: real ``timestamp_us`` (relative to the first recorded frame). Fine enough for any
#: cadence and keeps timing exact end-to-end.
_TIME_BASE = Fraction(1, 1_000_000)


def recording_available() -> bool:
    """True if PyAV is importable (the ``[h264]`` extra), so recording can run."""
    return importlib.util.find_spec("av") is not None


class _RecordingTap:
    """A non-viewer frame tap on a :class:`Display` (mirrors ``_ClientFeed`` minimally).

    Registered in the display's ``_taps`` set so :meth:`Display.publish` wakes it, but it
    is **not** a viewer — it does not count toward ``client_count`` or the adaptive
    downscale aggregation. Latest-frame-wins: on each wake it returns the newest
    published frame (a slower recorder skips intermediate frames, and the honored
    timestamps keep the file's timing faithful regardless).
    """

    def __init__(self, display: Display) -> None:
        self._display = display
        self._event = asyncio.Event()
        self._last_seen = 0
        self._closed = False
        display._add_tap(self)

    def _wake(self) -> None:
        self._event.set()

    def close(self) -> None:
        self._closed = True
        self._event.set()

    async def next_frame(self) -> RawFrame | None:
        """Park until the next distinct published frame; ``None`` once closed."""
        while True:
            if self._closed or self._display._closed:
                return None
            latest = self._display._latest
            version = self._display._version
            if latest is not None and version > self._last_seen:
                self._last_seen = version
                return latest
            self._event.clear()
            await self._event.wait()


class Recording:
    """Handle for an in-progress server-side MP4 recording.

    Created (and started) by :meth:`~pdum.rfb.display.Display.record`. Use it as an async
    context manager (auto-finalizes on exit) or call :meth:`stop` explicitly::

        async with display.record("out.mp4"):
            ...            # publish frames
        # -- or --
        rec = display.record("out.mp4")
        ...
        await rec.stop()   # flush the encoder, finalize the container

    Attributes
    ----------
    frames_written:
        Count of frames encoded into the file so far (useful for tests / progress).
    """

    def __init__(
        self,
        display: Display,
        path: str | Path,
        *,
        fps: int,
        bitrate: int | None = None,
        crf: int | None = None,
        preset: str = "veryfast",
    ) -> None:
        if not recording_available():
            raise RuntimeError(
                "Display.record() needs PyAV (the [h264] extra). Install with pip install 'habemus-papadum-rfb[h264]'."
            )
        if bitrate is not None and crf is not None:
            raise ValueError("pass at most one of bitrate / crf")
        self._display = display
        self.path = Path(path)
        self.fps = int(fps)
        self.bitrate = bitrate
        self.crf = crf
        self.preset = preset
        self.frames_written = 0

        self._tap = _RecordingTap(display)
        self._task: asyncio.Task | None = None
        self._stopped = False
        self._error: BaseException | None = None
        # PyAV objects, created lazily on the first frame (they need its dimensions).
        self._container: Any = None
        self._stream: Any = None
        self._size: tuple[int, int] | None = None
        self._t0_us: int | None = None
        self._last_pts: int = -1

    # --- lifecycle ---------------------------------------------------------

    def _start_task(self) -> None:
        """Launch the background encode task (called by :meth:`Display.record`)."""
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        """Stop recording and finalize the MP4 file (idempotent).

        Signals the tap to unpark, awaits the encode task (which flushes the encoder and
        closes the container in its ``finally``), then re-raises any error the task hit.
        """
        if self._stopped:
            return
        self._stopped = True
        self._tap.close()
        if self._task is not None:
            await self._task
            self._task = None
        if self._error is not None:
            raise self._error

    async def __aenter__(self) -> Recording:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.stop()

    # --- encode loop -------------------------------------------------------

    async def _run(self) -> None:
        try:
            # Open the container + libx264 context up front (off-thread), sized to the
            # display's current dimensions, so the one-time encoder init doesn't stall the
            # loop or make us drop the first frames while it warms up. Later frames of a
            # different size are scaled to fit in _write_frame.
            await asyncio.to_thread(self._ensure_container, self._display.width, self._display.height)
            while True:
                frame = await self._tap.next_frame()
                if frame is None:
                    break
                # Snapshot the (borrowed) pixels on THIS loop thread — no await between
                # next_frame() and here, so it is atomic w.r.t. a concurrent publish() —
                # then encode + mux off-thread so the event loop keeps serving viewers.
                host, av_format = _snapshot_host(frame)
                ts = int(frame.timestamp_us)
                await asyncio.to_thread(self._write_frame, host, av_format, ts)
        except BaseException as exc:  # noqa: BLE001 - stash and re-raise from stop()
            self._error = exc
        finally:
            self._display._remove_tap(self._tap)
            await asyncio.to_thread(self._finalize)

    def _ensure_container(self, width: int, height: int) -> None:
        """Open the MP4 container + libx264 stream, sized to the first frame."""
        import av

        self._container = av.open(str(self.path), mode="w")
        stream = self._container.add_stream("libx264", rate=self.fps)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        stream.codec_context.time_base = _TIME_BASE
        # No B-frames (tune=zerolatency) ⇒ output DTS == PTS, monotonic — trivial to mux
        # with our real-timestamp PTS. Constant-quality by default; bitrate/crf override.
        options = {"preset": self.preset, "tune": "zerolatency"}
        if self.bitrate is not None:
            stream.bit_rate = int(self.bitrate)
        else:
            options["crf"] = str(self.crf if self.crf is not None else 20)
        stream.options = options
        self._stream = stream
        self._size = (width, height)

    def _write_frame(self, host: np.ndarray, av_format: str, ts_us: int) -> None:
        """Encode one host frame and mux it (runs in a worker thread)."""
        import av

        h, w = host.shape[0], host.shape[1]
        if self._container is None:
            self._ensure_container(w, h)
        assert self._size is not None
        vframe = av.VideoFrame.from_ndarray(host, format=av_format)
        # Fix the frame size to the stream's (scale any later resize) and go to yuv420p.
        sw, sh = self._size
        vframe = vframe.reformat(width=sw, height=sh, format="yuv420p")

        if self._t0_us is None:
            self._t0_us = ts_us
        pts = ts_us - self._t0_us
        # PTS must strictly increase (a repeated/settled timestamp would stall the muxer).
        if pts <= self._last_pts:
            pts = self._last_pts + 1
        self._last_pts = pts
        vframe.pts = pts
        vframe.time_base = _TIME_BASE

        for packet in self._stream.encode(vframe):
            self._container.mux(packet)
        self.frames_written += 1

    def _finalize(self) -> None:
        """Flush the encoder and close the container (runs in a worker thread)."""
        if self._container is None:
            return
        try:
            if self._stream is not None:
                for packet in self._stream.encode(None):  # drain buffered packets
                    self._container.mux(packet)
        finally:
            self._container.close()
            self._container = None
            self._stream = None


def _snapshot_host(frame: RawFrame) -> tuple[np.ndarray, str]:
    """Return a private, contiguous host copy of ``frame`` and its PyAV pixel format.

    The copy defeats the ``publish()`` borrow aliasing (the returned array is safe to
    hand to a worker thread). GPU frames are downloaded to host first. Supports the
    common ``rgb24`` / ``rgba8`` host layouts (and their ``cuda`` / ``metal`` sources).
    """
    memory = frame.memory
    if memory == "metal":
        from .metal import to_host_frame

        frame = to_host_frame(frame)
        memory = frame.memory

    if memory == "cuda":
        import cupy as cp  # lazy: only when a cuda frame is recorded

        arr = cp.asnumpy(frame.data)
    elif memory == "cpu":
        arr = np.asarray(frame.data)
    else:  # opengl / other
        raise TypeError(f"recording does not support {memory!r} frames")

    if frame.pixel_format == "rgb24":
        return np.array(arr, dtype=np.uint8, copy=True, order="C"), "rgb24"
    if frame.pixel_format == "rgba8":
        return np.array(arr, dtype=np.uint8, copy=True, order="C"), "rgba"
    raise TypeError(
        f"recording supports rgb24 / rgba8 frames, got {frame.pixel_format!r}; publish RGB(A) frames to record."
    )
