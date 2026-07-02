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
        """
    )
    return


@app.cell
async def _():
    import itertools

    import numpy as np

    import pdum.rfb as rfb
    from pdum.rfb.notebook import publish_loop

    # marimo runs an event loop, so a cell can be `async` and use top-level await.
    # Plain CPU / image path: no GPU, no H.264 tuning, no frame-rate knobs. Just NumPy.
    display = await rfb.serve(320, 240, port=0)

    counter = itertools.count()

    def render():
        """One frame from scratch — a sliding orange block on a pulsing green field."""
        t = next(counter)
        frame = np.zeros((240, 320, 3), dtype=np.uint8)
        frame[:, :, 1] = t % 256  # background: pulsing green
        x = (t * 4) % 260  # block slides left -> right
        frame[90:150, x : x + 60] = (240, 120, 40)  # a moving orange block
        return frame

    # Push ~10 frames/sec on a background task; the cell returns immediately. Return `task`
    # so it stays referenced (asyncio holds only a weak ref) and is reachable for teardown.
    task = publish_loop(display, render, fps=10)
    display.ws_url
    return display, task


@app.cell
def _(display, mo):
    # Same process — the viewer connects back to the server over the WebSocket. Frames flow
    # over that socket, never through marimo's protocol. mo.ui.anywidget lets marimo track it.
    mo.ui.anywidget(display.widget())
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
        - **Headless execution** (e.g. `marimo export html`): no browser connects at all — the
          cells simply wire everything up, and no live view appears. That's expected.
        """
    )
    return


@app.cell(hide_code=True)
def _(mo):
    # marimo runs every cell on load, so gate teardown behind a button — otherwise the server
    # would close the instant the notebook opens. Headless (`export html`) never clicks it, so
    # the teardown cell below stops cleanly via mo.stop and the run exits 0.
    stop_button = mo.ui.run_button(label="Stop server")
    stop_button
    return (stop_button,)


@app.cell
async def _(display, mo, stop_button, task):
    mo.stop(not stop_button.value, mo.md("Click **Stop server** above to tear down."))
    task.cancel()
    await display.aclose()
    mo.md("Server stopped.")
    return


if __name__ == "__main__":
    app.run()
