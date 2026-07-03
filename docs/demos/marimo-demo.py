import marimo

__generated_with = "0.23.13"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo

    return (mo,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(
        r"""
        # `pdum.rfb` in marimo — renderer *and* viewer in one process

        The smallest possible remote-framebuffer demo, marimo edition: **one process** hosts
        both the Python renderer and the browser viewer. You draw plain NumPy frames into a
        `Display`; marimo wraps the [anywidget](https://anywidget.dev) with
        `mo.ui.anywidget(...)` and it connects over a WebSocket to show them live. No second
        process, no Node, no GPU — just **CPU encoding and NumPy**.

        Install with `uv add 'habemus-papadum-rfb[anywidget]'`.

        ## Why the buttons?

        marimo is **reactive** — it re-runs cells whenever their inputs change. A bare
        `await rfb.serve(port=0)` in a cell would rebind a **new** port on every re-run, and
        the viewer would keep chasing a socket that just moved (you'd see `ERR_CONNECTION_REFUSED`
        spam and a blank canvas). So the server is created **once** and stashed in `mo.state`,
        gated behind a button; the viewer connects only once it's up. Click **Start server**,
        then toggle **Show viewer**. **Tear down** stops the render loop and closes the socket.
        """
    )
    return


@app.cell
def _():
    import itertools

    import numpy as np

    import pdum.rfb as rfb
    from pdum.rfb.notebook import publish_loop

    counter = itertools.count()

    def render():
        """One frame from scratch — a sliding orange block on a pulsing green field."""
        t = next(counter)
        frame = np.zeros((240, 320, 3), dtype=np.uint8)
        frame[:, :, 1] = t % 256  # background: pulsing green
        x = (t * 4) % 260  # block slides left -> right
        frame[90:150, x : x + 60] = (240, 120, 40)  # a moving orange block
        return frame

    return publish_loop, render, rfb


@app.cell
def _(mo):
    # The running server lives in mo.state so it survives marimo's reactive re-runs: created
    # exactly once, torn down on demand. This is what keeps the port stable for the viewer.
    get_server, set_server = mo.state(None)
    return get_server, set_server


@app.cell
def _(mo):
    start_button = mo.ui.run_button(label="Start server")
    stop_button = mo.ui.run_button(label="Tear down")
    show = mo.ui.switch(value=True, label="Show viewer")
    mo.hstack([start_button, stop_button, show], justify="start", gap=1)
    return show, start_button, stop_button


@app.cell
async def _(get_server, publish_loop, render, rfb, set_server, start_button, stop_button):
    # Reacts to the two buttons. Reading get_server() here guards against a double-start and
    # lets us tear the right thing down; setting state re-renders the viewer cell (not this one,
    # so there's no self-loop). stats_interval=1.0 → the server pushes per-second metrics the
    # viewer folds into its Stats (fps / rtt / bitrate).
    _srv = get_server()
    if start_button.value and _srv is None:
        _display = await rfb.serve(320, 240, port=0, stats_interval=1.0)
        _task = publish_loop(_display, render, fps=10)
        set_server({"display": _display, "task": _task})
    elif stop_button.value and _srv is not None:
        _srv["task"].cancel()
        await _srv["display"].aclose()
        set_server(None)
    return


@app.cell
def _(get_server, mo, show):
    # Same process — the viewer connects back to the server over the WebSocket. Frames flow over
    # that socket, never through marimo's protocol. Shown only once the server is actually up.
    _srv = get_server()
    if _srv is None:
        _out = mo.md("**No server yet.** Click **Start server** above.")
    elif not show.value:
        _out = mo.md(f"Server up at `{_srv['display'].ws_url}` — toggle **Show viewer** to connect.")
    else:
        _out = mo.ui.anywidget(_srv["display"].widget())
    _out
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(
        r"""
        ## Network caveat — where the frames actually travel

        The viewer connects to a WebSocket that `rfb.serve()` opens on the machine running
        this process — the pixels flow over **that socket**, not over marimo's comm channel.
        So your browser has to be able to reach that host and port:

        - **Local notebook** (browser and process on the same machine): it just works over
          `localhost`.
        - **Hosted / deployed** (a remote box, a shared marimo server): the raw WebSocket port
          usually **isn't** directly reachable from your browser. You'd mount the ASGI hub
          same-origin and pass `base_path=` (see [the notebook guide](../notebook.md)), or set
          up SSH / port forwarding.
        - **Headless execution** (e.g. `marimo export html`): no button is clicked, so no server
          starts and no view appears — the notebook just renders its controls. That's expected.
        """
    )
    return


if __name__ == "__main__":
    app.run()
