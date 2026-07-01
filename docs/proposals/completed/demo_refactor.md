# Demo refactor — from a Textual TUI to a shipped web control plane

> **Status: SHIPPED.** The Textual TUI (`demo_tui.py` / `demo_app.py`) is gone. `pdum-rfb
> demo` now serves a single self-contained web app (`pdum.rfb.demo_server`, Starlette +
> uvicorn): the prebuilt SPA (`widgets/packages/demo-app/` → committed `static/demo/`), a
> REST control plane, and the framebuffer WS on one origin. The browser holds the viewer +
> all controls; Python only serves + logs. Shared/private streams, greying-out, the debug
> toggle (a new core-widget `debug` option), and the faicanteen styling all landed;
> `--smoke` (in-process `TestClient`) and a Playwright suite verify it. The **framework
> toggle** shipped as **Vanilla ⇄ React** (the seam takes Svelte/Solid next). `[demo]` is
> `[cli] + starlette + uvicorn`; a compound `[doctor]` extra was added. User docs +
> `doctor`/`demo` moved to `uvx`; the two-process dev demo moved to the development guide.
> See the user doc: [`docs/demo.md`](../../demo.md). The original design + Q&A is preserved
> below.

> **Status (original): proposal (design).** Rewritten from the dictated sketch. The goal is to
> retire the terminal (Textual) control panel and make `pdum-rfb demo` a single
> Python command that serves a **self-contained web app**: the browser holds both the
> remote-framebuffer viewer *and* the control plane (scene / backend / quality / the
> full parameter set), the Python process only serves the app + logs lifecycle events,
> and control actions ride **REST** calls. It ships prebuilt (no Node at runtime) and
> is meant to be run with **`uvx`**. Genuine design decisions are collected in
> [§13 Open questions](#13-open-questions--decisions-needed) with response blanks —
> please answer inline there.

---

## 1. Motivation & goals

The current `pdum-rfb demo` couples three things into a terminal experience: an
in-process `serve()` Display, a **Vite dev server** for the client, and a **Textual
TUI** as the control plane. It works, but:

- Textual is a poor fit — a framebuffer demo's natural home is the browser, next to
  the pixels it's controlling.
- It needs Node/Vite running to show the client, so "try it" is really "clone the
  repo, install the JS workspace, run two processes."
- The control plane (scene, backend, quality, stats) lives in the terminal, detached
  from the viewer; you can't share a URL, can't see it on a phone, can't easily grow
  it into the rich parameter surface the library now deserves (fit, DPR, color,
  match-client resize, pipelined encode, adaptive, still-after-settle…).

**Goals**

1. `pdum-rfb demo` starts **one** Python process that serves a web app and prints logs.
   No Node, no Vite, no second terminal at runtime.
2. The **control plane lives in the browser**, beside the viewer, driving the server
   over **REST**. Python logs each client connect, stream create/destroy, and command.
3. Ship the demo **prebuilt & minified** as Python package data (like the committed
   `static/widget.js` anywidget bundle), so `uvx --from 'habemus-papadum-rfb[demo]'
   pdum-rfb demo` just works.
4. Use the **batteries** viewer component, with a toggle to swap which **framework
   wrapper** (vanilla / React / Svelte / Solid) renders it.
5. Support **multiple clients** — both *coupled* (many viewers on one stream, to show
   fan-out) and *decoupled* (per-client private streams, to compare backends
   side-by-side and exercise the hub).
6. A **rich, discoverable parameter set** with unobtrusive inline help; unavailable
   backends/scenes are **greyed out** per platform.
7. A **soft, muted, editorial** look drawn from the `~/src/faicanteen` design tokens.
8. A **JS-console debug toggle** for verbose client-side logging (errors first).
9. Clarify the three "run this" surfaces in the docs (below).

**Non-goals** (this iteration): authentication/multi-user identity in the demo; a
public deployment story (the demo binds localhost); persisting demos server-side.

---

## 2. Today: what exists

**Control surface** (Textual, `demo_app.py`), all of which must move to the browser:

| Control | Wiring today |
| --- | --- |
| **Scene** | `_DemoState.select(key)` swaps what `_render_loop` publishes (server-global). |
| **Backend** | `_StreamHost.switch_backend(id)` — live reconfigure of every viewer + re-`config`. |
| **Quality** | `_StreamHost.set_quality(bitrate, fps)` — encoder rebuild for every viewer. |
| **Stats** | `_StreamHost.metrics()` — per-session fps/bitrate/encode-ms/RTT/inflight/dropped. |
| **Availability** | `available_demos()` / `available_backends()` filter by platform+deps. |

**Orchestration** (`demo_tui.py`): `serve()` + `_render_loop` + launch Vite +
`web_url(?ws=…)` + the Textual app; plus a headless **`smoke()`** that scripts a
WebSocket client through every backend and an input round-trip (the CI-grade proof).

**Packaging**: `pdum-rfb` is a Typer console script (`cli.py`: `doctor`, `benchmark`,
`demo`). The `[demo]` extra pulls `typer + rich + textual`. The anywidget bundle is
**committed package data** (`src/pdum/rfb/static/widget.{js,css}`, force-included in
the wheel) — the exact pattern the demo app will reuse. An **ASGI/Starlette** front
end already exists (`asgi.py`, `[asgi]` extra) exposing `rfb_endpoint` /
`rfb_hub_endpoint` over the same `Display`/`RfbSession` core.

---

## 3. The three "run this" surfaces, clarified

The docs currently point people at several things inconsistently. Proposed policy:

| Surface | Audience | How it's presented |
| --- | --- | --- |
| **`pdum-rfb demo`** (the new web app) | users / evaluators | `uvx --from 'habemus-papadum-rfb[demo]' pdum-rfb demo` → prints a localhost URL. |
| **`pdum-rfb doctor`** | users | `uvx --from 'habemus-papadum-rfb[cli]' pdum-rfb doctor` (uvx nuance → Q7). |
| **`python -m pdum.rfb.server` + `pnpm dev`** (2-process simple demo) | contributors | **Developer docs only** (`docs/development.md` / `widgets/README`), removed from user-facing pages. |

The standalone `python -m pdum.rfb.server` still backs the Playwright e2e and is handy
for contributors; it moves to developer docs rather than being suggested to users
(→ Q8). `uvx` replaces every "`pip install …[extra]` then run" instruction for the two
user-facing commands.

---

## 4. Target architecture — one Python-served ASGI app

**Recommendation (→ Q1):** the demo is a **Starlette ASGI app served by uvicorn**,
mounting four things on one origin/port:

```
GET  /                     -> the prebuilt demo SPA (StaticFiles: index.html + hashed assets)
GET  /demo/capabilities    -> { scenes:[…], backends:[…], platform:… }  (drives greying-out)
GET  /demo/state           -> current per-stream config (scene/backend/quality/params)
POST /demo/streams         -> create a private stream          (see §6)
DELETE /demo/streams/{name}
POST /demo/streams/{name}/scene    { key }
POST /demo/streams/{name}/backend  { id }
POST /demo/streams/{name}/quality  { bitrate, fps }
POST /demo/streams/{name}/params   { still_after, adaptive, resize_policy, color, … }
WS   /rfb/{name}           -> the framebuffer stream (rfb_hub_endpoint over the hub)
```

Why ASGI and not the bare `websockets` listener: the dictated design is explicitly
**REST-driven**, and Starlette gives us JSON `POST` routing, `StaticFiles` for the SPA,
and the WebSocket on the **same origin** (so the client connects same-origin — no
`?ws=` juggling, no CORS). It also **dogfoods** the existing `asgi.py` seam. The demo
extra becomes `starlette + uvicorn` (+ `typer` for the `pdum-rfb demo` wrapper);
`textual` is dropped.

`serve()` (the zero-dep `websockets` path) is unchanged and remains the library's
default; only the *demo* takes on the ASGI deps, which is fine for a `uvx` dev tool.

**Server modules.** `demo_app.py` (Textual) is deleted. `demo_tui.py` becomes
`demo_server.py`: a **StreamManager** owning `{name → (Display, _DemoState,
render_task)}`, the REST handlers (thin wrappers over the existing
`switch_backend`/`set_quality`/`_DemoState.select` + new param setters), the
capabilities probe, and the ASGI app factory. `available_backends`, `_parse_bitrate`,
`_render_loop`, `_DemoState`, and `smoke` are kept (smoke is re-pointed at the REST
plane — §12).

---

## 5. Control plane (REST) & capabilities

- **Mutations are REST `POST`s** returning the new stream state; the server **logs**
  each one to stdout (`INFO`: `client c3 → backend nvenc_cpu on stream "default"`).
- **Stats do *not* need REST.** The demo starts each stream with
  `serve(stats_interval=…, adaptive=…)`, so the server's authoritative `stats` push
  already flows over the viewer's WebSocket and the batteries widget surfaces it via
  `onStats`. The panel reads those. (Per-stream aggregate metrics remain available at
  `GET /streams/{name}/metrics` for a "server truth" panel.)
- **Greying-out.** `GET /demo/capabilities` returns `available_demos()` +
  `available_backends()` + platform facts; the panel renders every scene/backend but
  **disables** the ones absent here, with a muted "why" (`vtenc — macOS only`).
- A **param schema** (server-authored, consumed by the panel) keeps the UI and the
  server in sync: each field carries `{id, label, type, choices?, min?, max?, default,
  help, scope: "stream"|"viewer"}` so the panel can render controls + inline help
  generically and know whether a change is a REST call (stream) or purely local
  (viewer). (Which params ship → Q4.)

---

## 6. Streams & multiple clients

This is the crux the sketch left open ("clients don't necessarily have to be
coupled … useful to test multi-client"). The **hub already hosts multiple named
streams** on one port, each an independent `Display` with its own scene/backend/quality
— that is the enabling mechanism.

**Recommendation (→ Q2):** two modes, both first-class:

- **Shared stream (`default`)** — every viewer that joins `/rfb/default` sees the same
  frames (multi-client **fan-out**). Its controls are **global / last-writer-wins**:
  any client's change reconfigures all viewers. This is the honest demonstration of the
  library's core (N viewers, per-client backpressure, one Display).
- **Private streams** — a client can `POST /demo/streams` to spin up its **own**
  stream (`session-ab12`) with an independent render loop + scene/backend/params, then
  point its viewer at `/rfb/session-ab12`. Open two browser tabs, give each a private
  stream, and you can **compare backends/params side by side** and stress the hub.

The panel has a **stream selector**: *Shared* or *New private stream*. Private streams
are **auto-reaped** a short grace period after their last viewer disconnects, and
capped (e.g. 8) to bound resources. Lifecycle + cap details → Q2.

Open sub-question: whether opening the demo defaults you into the shared stream
(coupled, simplest first impression) or immediately mints a private one (decoupled,
no surprises when a colleague is also connected). Recommendation: **default to shared**,
one click to go private. (→ Q2.)

---

## 7. The demo SPA

**A new, unpublished npm project** (→ Q9 for its location — a `widgets/` workspace
member `demo-app/` vs a standalone dir). It depends on the core widget + the framework
wrappers, builds to a **minified SPA**, and its `dist/` is **committed as Python
package data** (`src/pdum/rfb/static/demo/`) and force-included in the wheel — exactly
how `static/widget.js` ships today, so `uvx` needs no Node.

**Layout.** A framework-agnostic **shell** (viewer slot + control rail) built from the
shared `rfb-ui` helpers/CSS (already the wrappers' shared foundation), styled per §9.

**Batteries viewer + framework toggle (→ Q3).** The viewer slot renders the
**batteries** component. A segmented **framework toggle** (Vanilla · React · Svelte ·
Solid) live-swaps which wrapper fills the slot: the vanilla shell keeps a disposer and
imperatively (re)mounts the chosen framework's `<RemoteFramebuffer>`
(`createRoot().render` / Svelte `mount` / Solid `render`) into the slot. All three
runtimes are bundled (acceptable for a dev demo). This proves every wrapper from one
page, live. (Alternative: multi-page, one route per framework, reload to switch —
simpler build, no live swap. Which → Q3; also: is anywidget in scope, or is it just the
notebook packaging of the same vanilla chrome?)

**Controls** (grouped, with inline help per §5's schema):

- *Stream* — stream selector (shared / new private); **Scene**; **Encode backend**
  (greyed per platform); **Quality** (bitrate, fps); the richer params (→ Q4:
  `still_after`, `adaptive`, `stats_interval`, `encode_pipeline_depth`,
  `resize_policy` + `max_render_dimension`, `color` sRGB/P3, resolution).
- *Viewer* (client-only, no REST) — **fit** (contain/cover/fill) + background,
  **debug logging** toggle (§8), **framework** toggle, capture (PNG), fullscreen,
  reconnect.
- *Stats* — live fps / bitrate / encode-ms / RTT / inflight / dropped / decode-queue
  from `onStats`, plus connection state.

Unobtrusive docs: each control gets a small muted "?" that reveals a one-line
description on hover/focus (a popover), so the surface is discoverable without clutter.

---

## 8. Debug logging (two halves)

**Python → stdout.** The server uses `logging` (default `INFO`) to print the lifecycle
the TUI log used to show: server start + URL, client connect/disconnect (with
`client_id`), stream create/destroy, every control command, scene/backend/quality
changes, and scene render errors. `-v/--verbose` raises to `DEBUG`. This *is* "the
Python thing printing out log information."

**JS console toggle.** Add a **`debug?: boolean`** option to the **core** widget
library (`RfbViewOptions` → worker init) — useful well beyond the demo. It gates a tiny
logger (`dlog(category, …)`, no-op unless enabled) threaded through the main thread and
the worker, surfacing what's currently swallowed: connection state transitions, the
negotiated `config`, keyframe requests + *why*, backpressure drops, decoder/WS
**errors** (today `catch {}`'d), and per-frame decode timings. The demo exposes a
toggle (persisted in `localStorage`, and honored from `?debug=1`) that flips it live.
Emphasis on errors, as requested. (Level: boolean vs category filters → Q5.)

---

## 9. Styling — warm-editorial, from `~/src/faicanteen`

Adopt the faicanteen **design tokens** verbatim (`src/styles/tokens.css`) for a soft,
muted, print-like feel:

```
--surface:#faf9f7  --ink:#2c2c2c  --ink-muted:#6b6560  --muted:#8a8278
--hairline:#c0b9ad  --ink-hover:#1a1a1a          /* monochrome-warm, no accent */
serif : "Cormorant Garamond", Georgia, serif      /* display + headings */
sans  : "Libre Franklin", Helvetica, Arial, sans  /* controls, labels */
digits: Georgia (tabular) for all numerals/stats   /* the faicanteen "Digits" trick */
--radius: 0   /* sharp, square, print-like */      hairline rules as dividers
```

Per the dictation we **exclude** the branded **"Tokyo Dreams"** display face and use
**Cormorant Garamond** for display instead. Controls are minimal and quiet; hairline
rules separate groups; the framebuffer viewport is the one dark/among focal element,
framed by a hairline on the warm surface. Fonts are **self-hosted** (subset `woff2`,
shipped with the SPA) so the offline `uvx` demo needs no font CDN — Cormorant Garamond
+ Libre Franklin are open-licensed; Georgia is a system fallback. (Confirm exclusions /
self-hosting / viewport treatment → Q6.)

---

## 10. Packaging & delivery

- **Built SPA → package data.** `demo-app` builds to `src/pdum/rfb/static/demo/`
  (committed, `.map` gitignored), added to `[tool.hatch.build.targets.wheel.force-include]`
  next to the widget bundle. A `pnpm -C widgets build:demo` script (mirroring
  `build:anywidget`) regenerates it; a pre-commit / release check keeps it fresh.
- **`[demo]` extra** → `["typer>=0.12", "starlette>=0.37", "uvicorn>=0.30"]` (drop
  `textual`; `rich` optional for pretty logs). `dev` group drops `textual`.
- **uvx UX** → `uvx --from 'habemus-papadum-rfb[demo]' pdum-rfb demo` (confirm the
  invocation shape / whether a dedicated `pdum-rfb-demo` entry point is nicer → Q10).
- **Removed**: `demo_app.py`, the `textual` dependency, and the Vite-launch code in the
  orchestrator (`_launch_vite`/`_wait_port`/`find_widgets_dir` for the runtime path).

---

## 11. Implementation plan (phased, each independently shippable)

- **P0 — Docs/CLI clarification.** Rewrite user-facing run instructions to `uvx`; move
  the `pnpm dev` two-process demo to developer docs. Cheap, no code. (Unblocks nothing;
  do first so the docs stop pointing at the old flow.)
- **P1 — Core `debug` logging.** Add `RfbViewOptions.debug` + the worker/main `dlog`
  logger + surface swallowed errors. Independent, generally useful, unit/e2e-testable.
- **P2 — ASGI demo server.** `demo_server.py`: StreamManager, REST routes, capabilities,
  StaticFiles mount, per-stream render loops, stdout logging. Keep `serve()` intact.
  Re-point `smoke()` at the REST plane. (Gated on Q1/Q2/Q4.)
- **P3 — Demo SPA.** New `demo-app` npm project: shell + control rail (rfb-ui + faicanteen
  styling), param schema rendering + inline help, greying-out, stats, stream selector,
  framework toggle, debug toggle. Build → `static/demo/`. (Gated on Q3/Q6/Q9.)
- **P4 — Packaging & cutover.** force-include the built SPA; swap `[demo]` deps; delete
  `demo_app.py` + `textual`; `pdum-rfb demo` launches uvicorn on the ASGI app; rewrite
  `docs/demo.md`; fix cross-doc references.
- **P5 — Tests.** Extend `smoke` (REST control + fan-out + a private stream); Starlette
  `TestClient` unit tests for the REST routes + capabilities; a Playwright e2e that
  boots `pdum-rfb demo`, drives the panel (switch scene/backend/quality), and asserts
  the viewer + a REST round-trip; a greying-out assertion.

---

## 12. Testing

- **`smoke` (headless, CI-grade)** stays the backbone but drives the **real control
  plane**: `POST` each backend/scene/quality change over REST while a scripted WS client
  verifies frames decode — plus a 2-viewer fan-out check and a private-stream create →
  connect → destroy cycle.
- **REST units** via Starlette `TestClient`: capabilities shape, each mutation returns
  updated state + logs, unknown stream → 404, private-stream lifecycle + cap.
- **Playwright e2e**: boot `pdum-rfb demo`, assert the SPA loads, a scene/backend switch
  reaches the server (`/demo/state`), the viewer decodes a frame, and the debug toggle
  emits console logs. (The e2e harness runs here — see `CLAUDE.md`.)
- **Greying-out**: capabilities on a plain box hides vtenc/nvenc; the panel disables them.

---

## 13. Open questions & decisions needed

*(Please answer inline after each **Response:**. Ordered roughly by how much they gate
the rest.)*

**Q1 — Server architecture.** Make the demo a **Starlette + uvicorn ASGI app**
(same-origin static + REST + WS, dogfoods `asgi.py`), taking on `starlette`/`uvicorn`
as `[demo]` deps? Or keep it on the bare `websockets` listener and hand-roll REST/static
over its HTTP side-channel (fewer deps, more custom code)?
**Response:** AGREED -- starlette

**Q2 — Multiple clients / stream model.** Adopt **shared `default` (coupled, fan-out) +
optional per-client private streams (decoupled)**? Default new visitors into *shared*
or *private*? Auto-reap private streams on last-viewer-disconnect (grace period), and
cap at ~8? Any different model you'd prefer?
**Response:** Defer to you -- your thoughts look complete

**Q3 — Framework toggle.** Live-swap **Vanilla · React · Svelte · Solid** batteries
viewers inside one vanilla shell (all runtimes bundled), or **multi-page** (one route
per framework, reload to switch)? Which frameworks are in scope — include a "Vanilla"
(core + rfb-ui) option? Is **anywidget** in scope, or is it just the notebook packaging
of the same vanilla chrome (i.e. out of scope here)?
**Response:** defer to you on all -- maybe notebooks (marimo/jupyter) should be tables for now

**Q4 — Parameter scope.** Which parameters should the panel expose? Proposed **stream**
params: scene, backend, bitrate, fps, resolution, `still_after`, `adaptive`,
`stats_interval`, `encode_pipeline_depth`, `resize_policy` + `max_render_dimension`,
`color` (sRGB/P3). Proposed **viewer** params: fit + background, framework, debug,
capture, fullscreen, reconnect. Add/remove anything? Any that should be read-only
"observability" rather than editable?
**Response:** defer to you

**Q5 — Debug logging shape.** Add `debug` to the **core** `RfbViewOptions` (recommended,
not demo-only)? Boolean on/off, or category filters (`ws`, `decode`, `backpressure`,
`config`, `errors`)? Default level for the **Python** side — `INFO` with `-v` → `DEBUG`?
**Response:** agree and defer to you -- you mare need to add loggin into the core js widget (not just demo code)

**Q6 — Styling specifics.** Confirm: adopt the faicanteen tokens, **exclude "Tokyo
Dreams"** and use **Cormorant Garamond** for display, **self-host** Cormorant Garamond +
Libre Franklin (offline `uvx`), Georgia/serif fallback. How should the **framebuffer
viewport** sit in the warm-editorial layout (dark panel with a hairline frame? inset on
the surface?)? Anything from the fai-canteen PDFs I should match more precisely?
**Response:** dark / w hairline sounds good -- defer to you on the rest

**Q7 — `doctor` under `uvx`.** Run via `uvx`, `doctor` probes an **ephemeral** env, so
pip-installed encoders (PyAV/CuPy) in *your* project won't show — it will report
platform capability (macOS→vtenc, Linux+GPU→nvenc) and "install X to enable Y". Is that
the intended semantic? Options: (a) keep it (fresh-env recommendation), (b) have doctor
clearly split "installed here" vs "available on this platform", (c) suggest
`uvx --from 'habemus-papadum-rfb[cli,h264,gpu-…]'` to probe with encoders present.
**Response:** _..._ c) the doctor should be able to run in a fresh env and report what is available on the platform. It should also be able to report what is installed in the current environment. So I think a combination of (a) and (b) would be best. If possible, maybe use a compound extra that can have all the things that you have there, a doctor extra, but only if it's easy to maintain. I don't want to have to copy and paste. Dependencies in the Project Tomlin

**Q8 — The standalone test server.** Keep `python -m pdum.rfb.server` as a
**developer-docs** tool (it backs the Playwright e2e) and remove it from user-facing
pages? Or fold its role entirely into the demo?
**Response:** dec docs tool

**Q9 — Demo npm project location & build output.** Make `demo-app` a **`widgets/`
workspace member** (shares deps/tooling with the wrappers) or a **standalone** top-level
project? Commit the built `dist` as package data (like `widget.js`) — confirm — and is
`pnpm -C widgets build:demo` the right build entry point?
**Response:** defer to you

**Q10 — uvx invocation & entry point.** Is `uvx --from 'habemus-papadum-rfb[demo]'
pdum-rfb demo` the UX you want, or would a dedicated console script (e.g.
`pdum-rfb-demo`, so `uvx habemus-papadum-rfb-demo`-style) read better? Should `demo`
bind **localhost only** (recommended) with a `--host` opt-out?
**Response:** `uvx --from 'habemus-papadum-rfb[demo]'
pdum-rfb demo` , localhost only

**Q11 — Anything under-specified?** Shareable/reproducible demo state via a URL-encoded
param set? A "reset to defaults" affordance? A visible server-log stream in the browser
(mirroring stdout) or is stdout enough? Note anything else you'd want.
**Response:** defer to you -- but looks complete to me
