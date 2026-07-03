# Fixing the marimo demo (blank viewer + no auto-run) — investigation & plan

**Status:** _active / in-progress._ Root cause of the blank viewer narrowed to an
OffscreenCanvas→DOM-placeholder **compositing** failure inside marimo; the decode/draw
path is proven correct. Fix not yet landed. This doc records what was tried, what was
confirmed, and what's next — plus a **standalone observability section** (§7) whose lessons
outlive this bug and should eventually move to their own file / into the
`frontend-debugging` skill.

> **Live state as of this writing (left "hot" on purpose):**
> - A marimo edit server is running headless on `http://localhost:2719` serving a copy of
>   `docs/demos/marimo-demo.py` (scratchpad copy). Click **Start server** to reproduce.
> - `widgets/anywidget/entry.ts` carries **three temporary debug edits** (see §6) and the
>   built bundle `src/pdum/rfb/static/widget.js` was rebuilt from them. These are NOT to be
>   committed — §6 has the exact lines + revert steps.

---

## 1. The two reported problems

1. **The notebook doesn't run automatically on load.** The user opens the demo and nothing
   happens until they manually run cells / click a button; "most people don't know what to
   do with that."
2. **The viewer is blank even after clicking Start server.** The widget mounts, the status
   pill says **live**, the badge reads **H.264 · 10 fps · 1 ms** — but the canvas is solid
   black. "There's an attempt to try to fix it, but it doesn't seem fixed."

Problem 2 is the substantive bug. Problem 1 is partly a marimo-config fact and partly a
demo-UX choice (§5).

---

## 2. How it was reproduced (Chrome MCP + headless marimo)

The whole loop ran headless through the Chrome browser automation tools, driving a real
Chrome (not SwiftShader), against a real marimo kernel:

```bash
# 1. copy the demo out of the source tree (marimo writes session state next to the file)
cp docs/demos/marimo-demo.py "$SCRATCH/marimo-demo.py"

# 2. launch marimo headless on a fixed port, no token (so the MCP browser can open it)
uv run marimo edit "$SCRATCH/marimo-demo.py" --headless --host 127.0.0.1 --port 2719 --no-token
```

Then, in Chrome: navigate to `http://localhost:2719`, scroll to the controls, click **Start
server**, wait, and inspect. The viewer connects to the WebSocket that `rfb.serve()` opened
in the same kernel process — i.e. the exact wiring `pdum-rfb marimo-demo` produces.

**Gotcha that cost time (write this down):** marimo **reconnects to the existing kernel
session** across page reloads and **caches the rendered anywidget**, so simply reloading the
page after rebuilding `widget.js` does *not* pick up the new bundle. You must **restart the
marimo process** (fresh kernel → re-imports `pdum.rfb.notebook` → re-reads the on-disk
bundle) to test a rebuilt widget. A `--no-token` fixed port makes the restart cheap.

---

## 3. What was confirmed (evidence, not inference)

### 3.1 The network + decode path is healthy

Live `Stats` read off the widget (via a temporary `window.__rfbStats` hook, §6):

```json
{
  "framesDisplayed": 146, "framesDropped": 0, "lastDisplayedSeq": 145,
  "decodeQueueSize": 0, "transport": "webcodecs", "surface": "2d",
  "codec": "avc1.42E01F", "colorSpace": "bt709", "frameWidth": 320, "frameHeight": 240,
  "serverRttMs": 1.63, "serverFpsSent": 10, "serverBitrateBps": 37176, "serverEncodeMs": 1.98
}
```

`framesDisplayed` climbs, `framesDropped` is 0, `decodeQueueSize` is 0 → the WebCodecs
`VideoDecoder` is configured, fed, and emitting output frames, and `renderer.draw()` is
being invoked ~10×/s. The chrome's loading spinner hides only when `framesDisplayed > 0`,
and it was hidden — the client itself *believes* it is presenting frames.

### 3.2 The worker IS drawing the frame correctly

The decisive test. `capture('imagedata')` reads the worker's canvas back with
`getImageData` (via a temporary `window.__rfbCapture` hook, §6) and we histogram it:

```
capture → { w: 1332, h: 600, pctNonBlack: "60.1", maxR: 251, maxG: 153, maxB: 45 }
```

- **60.1% non-black** is exactly the letterbox ratio: a 320×240 frame drawn `contain` into a
  1332×600 backing occupies 800×600 = 60.06% of the area. The bars are black; the picture is
  not.
- **maxR 251 / maxG 153 / maxB 45** are the demo's orange block (`(240,120,40)`) and pulsing
  green field — i.e. the *actual rendered content_, not noise.

So the worker's OffscreenCanvas backing store **contains the correct picture.** The decode
→ `Canvas2dSurface.setFrame` → `present()` → `drawImage` chain works.

### 3.3 …but the on-screen placeholder canvas is black

A screenshot of the same widget at the same moment shows a solid black canvas (only the
overlaid status pill + badge text are visible). And the canvas's own CSS is clean — nothing
is hiding it:

```
canvas: display block, visibility visible, opacity 1, transform none, filter none,
        background rgba(0,0,0,0), CSS size 1065×480, backing 1332×600
```

### 3.4 Conclusion

This is **not** a decode bug, a geometry bug, or a "frames aren't arriving" bug. The
worker draws into the transferred `OffscreenCanvas`, `getImageData` on that surface returns
the picture, but the **DOM placeholder `<canvas>` that `transferControlToOffscreen()`
returned control from is not being updated on screen.** The pixels exist; they are not
being **composited** to the display.

Two structural facts make this marimo-specific and point at the cause:

- The widget is rendered **inside a shadow root** (marimo wraps anywidget output). The
  canvas had to be found with a shadow-piercing deep query; a top-level
  `document.querySelector('canvas')` misses it.
- The standalone `pdum-rfb demo` / Playwright e2e **does not exhibit this** — but note the
  e2e asserts pixels via `capture()` **readback**, which reads the *worker* surface (§3.2),
  **not** a screenshot of the composited placeholder. So the e2e is **blind to exactly this
  failure mode.** (That's a test-coverage finding in its own right — see §7.5.)

---

## 4. Root-cause hypotheses (ranked) and the plan to settle them

The mechanism is "OffscreenCanvas placeholder stops propagating to the compositor." Ranked
candidates, each with a concrete next test:

1. **marimo re-renders / reparents the widget subtree after `transferControlToOffscreen()`
   (leading candidate).** anywidget's `render()` transfers canvas control immediately in the
   `RemoteFramebufferView` constructor; if marimo's virtual DOM later moves, detaches/reattaches,
   or replaces the host element (it re-runs the viewer cell on the `mo.state` change from
   Start server, and syncs `stats` back to Python every second), the placeholder→compositor
   link can be severed while the worker keeps happily drawing into the orphaned surface.
   - **Test:** instrument the anywidget `render()` to log when `el`/canvas
     `isConnected` flips, and watch a `MutationObserver` on the host for detach/reattach
     around the Start-server transition. Correlate with the first black frame.

2. **Transfer happens before the canvas is composited (connected-but-not-yet-presented).**
   `getBoundingClientRect()` returned a non-zero size here (1065×480), so it isn't the
   classic zero-size case — but "laid out" ≠ "has a live compositor surface." If marimo
   mounts the output detached and attaches after, the transfer races the surface creation.
   - **Test:** defer the whole worker-init (canvas creation + transfer) until the element is
     both `isConnected` and has had one animation frame / `IntersectionObserver` tick in the
     document, then reproduce.

3. **Opaque sibling overlay inside the shadow root.** The CSS check cleared the canvas
   itself, but a proper shadow-root hit-test at the (post-scroll) on-screen center wasn't
   completed before the pause.
   - **Test:** `shadowRoot.elementFromPoint(cx, cy)` at fresh coords; confirm it returns the
     canvas and not `.rfb-loading` / `.rfb-banner` / `.rfb-status`. (Low probability — the
     badge text renders on top of black, implying we're seeing the canvas, not a cover.)

4. **Shadow-DOM × OffscreenCanvas propagation quirk.** Least likely; falsify by mounting the
   same `RemoteFramebufferView` in light DOM vs a shadow root against the same server and
   screenshotting both.

### Candidate fixes (once the mechanism is pinned)

- **Cheap/local:** if it's reparenting (H1), detect a placeholder that has gone stale
  (canvas `isConnected` false, or a disconnect/reconnect observed) and **rebuild** — recreate
  the `<canvas>` + worker (you can't re-transfer an already-transferred canvas). anywidget
  already exposes a `reconnect()` control that calls `build()`; the gap is *automatic*
  detection.
- **Robust/structural — and this is the interesting one:** stop relying on
  `transferControlToOffscreen` placeholder auto-present for fragile embedding hosts. Move to
  **Mode B present** from `docs/proposals/active/client_display_backend.md`: the worker draws
  to an `ImageBitmap` and `postMessage`/transfers it to the **main thread**, which draws it to
  a normal main-thread 2D canvas on a `requestAnimationFrame` loop. That sidesteps the
  worker-owned placeholder entirely and is inherently resilient to host reparenting. **The
  marimo compositing fragility is a concrete, real-world motivation for Mode B** — worth
  citing there.

Either way the fix should be **locked in with a test that screenshots the composited output**
(not just `capture()` readback) in an embedding closer to marimo's — see §7.5.

---

## 5. Problem 1 — "doesn't run automatically"

**What was observed:** in this environment marimo *did* auto-instantiate on load — the
markdown cells rendered and the viewer cell ran to "No server yet." So cells run; what
doesn't happen automatically is the **server start**, which is gated behind the
`mo.ui.run_button("Start server")` by design (the notebook's own "Why the buttons?" markdown
explains it: a bare `await rfb.serve(port=0)` rebinds a new port on every reactive re-run).

So Problem 1 has two independent pieces:

- **marimo's own autorun config.** Whether cells run on open is the reader's marimo setting
  (`runtime.auto_instantiate`, and `on_cell_change` autorun vs lazy). A reader with autorun
  off sees a fully "stale" notebook. We can't force their global config, but we can (a)
  document it prominently in the demo's intro cell, and (b) prefer a design that's obviously
  actionable when nothing has run.
- **The demo requires a click to show anything.** Even with autorun on, the viewer stays
  empty until Start server. The user's ask: *"better to have the demo just run automatically
  unless the user's config doesn't allow it."*

**Fix direction (to design alongside the render fix):** auto-start the server **once**, safely
under reactive re-runs, without the button — the constraint the buttons were avoiding is
port-churn on re-run, which is solvable by starting the server in a cell that has **no
reactive inputs that change** (so it runs exactly once at instantiate) and stashing it in
`mo.state`, rather than by gating on a click. Keep a **Tear down** button. The subtlety is
marimo's rule against a cell reading and setting the same state (self-loop); the current
notebook already splits state-set (button cell) from state-read (viewer cell), so the
auto-start version needs the creating cell to *not* read the `get_server` getter it writes.
This wants its own small design pass + a note about the autorun caveat in the intro cell.

---

## 6. Temporary debug hacks currently in the working tree (REMOVE before commit)

Recorded verbatim so they can't get lost. All are in `widgets/anywidget/entry.ts`, tagged
`// TEMP-DEBUG`, and the built `src/pdum/rfb/static/widget.js` was regenerated from them
(`pnpm -C widgets build:anywidget`). They exist only because the "proper" observability
(§7) doesn't exist yet — turning these into permanent, runtime-toggleable hooks is the whole
point of §7.

```ts
// in the RfbViewOptions passed to new RemoteFramebufferView(...):
debug: true, // TEMP-DEBUG   ← forces the verbose worker+view logger on

// in onStats:
(window as any).__rfbStats = s; // TEMP-DEBUG   ← latest Stats readable from the JS console

// after build():
(window as any).__rfbView = () => view;                                   // TEMP-DEBUG
(window as any).__rfbCapture = (fmt: "imagedata" | "blob") => controls.capture(fmt); // TEMP-DEBUG
//   ↑ capture() reads the WORKER surface back — the §3.2 ground-truth probe
```

**Revert:**

```bash
git checkout widgets/anywidget/entry.ts
pnpm -C widgets build:anywidget      # rebuild a clean bundle
# and stop the warm marimo server (port 2719) when done
```

---

## 7. Observability lessons (standalone — extract to its own doc/skill later)

The bug was findable only because we could read the worker's surface and the live stats from
the JS console. Getting there required ad-hoc hacks (§6). The general lesson: **the client
should ship the hooks that made this debuggable, as first-class, runtime-toggleable
features** — off by default, zero console spam in normal use, flippable from the Chrome
console without a rebuild. Below is what to build.

### 7.1 The hard constraint we hit: **worker `console.*` is not readable via the MCP browser tools**

`mcp__claude-in-chrome__read_console_messages` surfaced **only main-thread/page** console
lines in this session; the worker's `console.debug/info/error` (the `[rfb:worker|decode|…]`
stream from `debug.ts`) did **not** appear, even with `debug:true`. So the single richest
log stream in the client is invisible to the exact tool an agent uses to debug it.

**Implication / design rule:** anything you want an agent to *see* must reach the **main
thread**. Two mechanisms, both worth having:

- **Forward worker logs to main.** The worker already has a `Logger` (`makeLogger`). Add a
  sink that also `postMessage`s each emitted line (`{type:"log", level, category, args}`) to
  the main thread, where a main-thread handler re-`console.*`s it (now MCP-readable) **and**
  pushes it into a bounded ring buffer on `window.__rfb.logs` (last N lines, readable
  without a live console). Gate the forwarding behind the same debug flag so it costs nothing
  when off.
- **Expose a state snapshot on `window`.** Even with no logs, `window.__rfb.stats()` /
  `.state()` / `.surface()` / `.capture()` let an agent (or human) interrogate the live view
  from the console. This is the productized form of the §6 hacks.

### 7.2 Runtime-toggleable debug, not compile-time

Today `debug` is fixed at construction (`makeLogger(false, …)` in the worker; an option on
the view). Debugging a *running* page then needs a rebuild + kernel restart (§2) — slow.
Make it flippable at runtime:

- `window.__rfb` = a small registry of live views (each `RemoteFramebufferView` registers
  itself on construct, deregisters on `dispose`). For a single-widget page,
  `window.__rfb.view` is the one; for many, `window.__rfb.views[]`.
- `window.__rfb.setDebug(true)` → posts a `{type:"set_debug", debug:true}` to the worker,
  which **rebuilds its `dbg`** (and the main-thread view flips its own logger). No rebuild, no
  restart. `setDebug(false)` restores silence.
- Discoverability: on first construct, emit **one** `notice` line naming the handle, e.g.
  `[rfb:view] debug hooks at window.__rfb — .setDebug(true), .stats(), .capture()`. One line,
  not spam, and it tells a human/agent exactly what to type.

Optional convenience toggles for parity with the demo: honor `?debug=1`, and/or a
`localStorage.rfbDebug` flag read at construct — so a reload can start verbose without
touching code.

### 7.3 Cadence logging (a heartbeat), not per-frame spam

Per-frame `log()` is a firehose that's useless at 30–60fps and drowns the console. The
useful middle ground the user asked for: **a periodic one-line summary.** Add a heartbeat
(default every ~5s, `notice`-level so it rides the normally-on tier, or gated to debug —
TBD) emitted from the worker and forwarded to main:

```
[rfb:hb] fps 10.0 displayed 146 dropped 0 queue 0 · webcodecs/2d · rtt 1.6ms seq 145
```

Rules that keep it clean: one line per interval; only when something is flowing (skip when
idle/closed, or emit a single `idle` line and then go quiet); include the fields that
actually localize bugs — `transport`, `surface`, `framesDisplayed`/`dropped` deltas,
`decodeQueueSize`, `recoveries`, `serverRttMs`. This same summary is what
`window.__rfb.stats()` returns, so the console stream and the pull-hook agree.

Errors and rare lifecycle events keep their existing always-on / notice tiers
(`debug.ts` §header) — the heartbeat is additive, for "is it healthy right now?"

### 7.4 Screenshot-vs-readback: name the distinction, because they disagree

This bug is the poster child: **`capture()` readback (worker surface) said "picture present";
a screenshot (composited placeholder) said "black."** When debugging a "blank/black" symptom,
always check **both**:

- `capture()` green + screenshot black → **compositing/DOM/host** problem (this bug).
- `capture()` black + screenshot black → **decode/draw** problem (upstream of present).
- both green but user says black → they're looking at the wrong element / a cached view.

An agent debugging via MCP should learn to reach for `window.__rfb.capture()` and a
`screenshot` and compare, rather than trusting either alone.

### 7.5 Test coverage follow-up

The e2e's pixel assertions go through `capture()` readback, so they **cannot catch a
compositing/placeholder regression** like this one. Add at least one check that asserts on a
**screenshot of the composited canvas** (Playwright `toHaveScreenshot` / a sampled
`page.screenshot` region), ideally in a shadow-DOM / reparenting harness that mimics marimo's
embedding. This is the "lock it in" step for the eventual fix (§4).

### 7.6 Chrome-MCP debugging playbook (marimo & friends)

Concrete tricks that worked here, for the skill:

- **Multiple browsers connected** → the tools force a `switch_browser`/`select_browser`
  choice; surface the list to the human and let them pick (done via `AskUserQuestion`).
- **Shadow DOM** → top-level `querySelector` misses widget internals. Use a shadow-piercing
  deep query (walk `el.shadowRoot` recursively) to find the canvas / `.rfb-root`.
- **Transferred canvas is unreadable from main** (`getContext` throws post-transfer) — don't
  try to `getImageData` it on the main thread; go through the worker's `capture()`.
- **marimo caches the rendered widget across reloads** → restart the kernel to test a rebuilt
  bundle (§2).
- **Fixed port + `--no-token` + `--headless`** makes marimo scriptable from the browser tool.

---

## 8. Open questions

- Which hypothesis in §4 is correct? (H1 reparenting is the bet; needs the `isConnected` /
  `MutationObserver` instrumentation.)
- Should the auto-start (§5) be the default demo shape, or a second "no-buttons" demo variant,
  given the reactive-re-run/port-churn constraint?
- Heartbeat tier: `notice` (visible by default) vs debug-gated? Leaning debug-gated + a
  single always-on "connected/negotiated" notice, to honor "don't spam."
- Where do §7's hooks live so they're shared by the standalone view **and** the anywidget
  (and the framework wrappers)? Likely in `RemoteFramebufferView` + `debug.ts`, with the
  anywidget just opting in, so every embedding gets them for free.
