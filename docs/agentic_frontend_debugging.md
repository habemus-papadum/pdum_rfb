# Agentic frontend debugging

A playbook for debugging the browser client with an agent in the loop — and, more durably, a
set of **instrumentation patterns** that make a streaming frontend debuggable *before* you hit
a bug. It grew out of a real incident: a decoder would stall on resize and the page went to a
**black screen with zero console output** — nothing to read, nothing to grep, no way to tell an
agent "here's what I see." The fixes below (a tagged logger, a stall watchdog, observable error
paths, a live-reload dev loop) are what turned that class of failure from *invisible* into
*named, counted, and reproducible*.

Two halves: **how to instrument for debuggability**, then **the pairing workflow** that uses it.

## Part 1 — Instrument for debuggability

The goal: when something goes wrong, the failure should announce itself in a form a human can
read aloud and an agent can grep — not require a debugger session to even *observe*.

### 1. A gated, tagged logger — quiet by default, loud on demand

`widgets/src/debug.ts` exposes `makeLogger(enabled, tag)` returning `{ enabled, log, error }`:

- **`log`** is gated by a flag (off by default) → `console.debug`. Hot paths stay silent in
  production; a single toggle turns on the whole play-by-play.
- **`error`** is *always* on → `console.error`. Failures are never gated away.
- Every line is **tagged** (`[rfb:worker]`, `[rfb:view]`, `[rfb:decode]`, `[rfb:stall]`,
  `[rfb:recover]`, `[rfb:ws]`) so the console is greppable by subsystem.

The flag rides in from the outside — `RfbViewOptions.debug` / `?debug=1` on the demo → the
worker `init` message (`WorkerInitOptions.debug`) → the module-level `dbg` in `worker/entry.ts`
→ the `VideoPipeline`. One switch lights up main thread **and** worker.

> Rule: instrument at the **seams**, not everywhere. WS connect/close, decoder `configure`,
> the keyframe gate, each decoded frame, stall detection, recovery. Those are where streaming
> breaks; a log at each turns "it froze" into "it froze *right after `configure`*".

### 2. Make failure paths observable — never silent

The incident's root cause was a *silent* catch surface. Every error/empty path now emits:

- The `VideoDecoder` `error` callback logs (`[rfb:decode] VideoDecoder error`) **and** re-arms
  (reset the keyframe gate, request a keyframe) — see `worker/videoDecode.ts`.
- `decoder.configure()` is wrapped in `try/catch`: a throw is **fatal** (unsupported codec),
  so it posts `{type:"error"}` to the main thread (→ `onError`, a visible state) rather than
  leaving a dead decoder.
- Image-decode failures are caught and logged instead of vanishing.

> Rule: every `catch` and every early-`return`-on-empty emits *something*. A failure you can't
> see is a failure you can't hand to an agent.

### 3. Instrument the *absence* of progress, not just errors

The nastiest streaming bugs throw nothing — the decoder simply stops emitting frames (hardware
DPB buffering, a dropped keyframe, a wedged reference chain). `worker/stallWatchdog.ts` turns
that silence into an event:

- It tracks `queued − displayed` and the wall-clock age of the oldest outstanding chunk. A
  backlog that produces **zero output for ~1.2 s** is a stall.
- On a stall it logs (`[rfb:stall]`), rebuilds the decoder, requests a keyframe, tells the
  server to release its inflight, and bumps a **`recoveries`** counter surfaced in `Stats`
  (visible in the demo HUD).

So an invisible deadlock ("black screen, no logs") becomes a named, counted, logged, and
*self-healing* event. `StallWatchdog` is deliberately **pure and DOM-free** so the logic is
unit-testable headlessly (`widgets/tests/unit/stallWatchdog.test.ts`) — see rule 6.

### 4. Fix deadlocks at *both* ends

A client-side recovery is only half a fix if the server is also wedged. The stall deadlock was
mutual: the client only ACKs on display, the server only sends when inflight has room → one
stalled decoder froze both forever. So the client's recovery sends a **`decoder_reset`**
control, and the server *also* has an independent **inflight-timeout backstop** (`session.py`):
a seq unacked past ~2 s clears inflight and forces a keyframe even if the client says nothing.

> Rule: when you instrument one side of a two-party protocol, ask what the *other* side does
> while the first is stuck. Add the symmetric backstop, or the bug comes back wearing a hat.

### 5. Expose server truth over a side channel

Don't make the browser the only place state lives. This project exposes:

- opt-in `stats` control frames (server → client) folded into the client `Stats`;
- REST introspection — `GET /demo/capabilities`, `GET /streams`, `GET /metrics` — so both
  sides' truth is inspectable with `curl`, no debugger attached.

### 6. Keep the logic testable headlessly

The headless e2e (Playwright + SwiftShader) uses a **software** decoder — it will not reproduce
a *hardware* buffering stall. So the resilience logic is factored into pure units you can test
by **simulating the trigger**: inject a clock, feed `onQueued` with no `onDisplayed`, assert the
watchdog trips. Determinism hooks (injected `now`, plain counters) are themselves an
instrumentation choice — they make the failure reproducible in CI, not just in someone's hands.

## Part 2 — The pairing workflow

### Start the live-reload loop

```bash
pdum-rfb demo --dev --open
```

`--dev` runs the SPA under **Vite (instant TS HMR)** and the API under **uvicorn `reload=True`
(Python auto-restart)**; the browser opens on the Vite URL, which proxies REST + the framebuffer
WebSocket back to Python. `--open` launches the browser; the port is a **free one picked at
random** (pass `--port N` to pin it). Edit either side → it's picked up live, no manual restart.

### The loop

1. **Reproduce.** The human drives the UI and triggers the glitch (resize, backend switch, …).
2. **Read all four channels.** Browser console with the demo's **Debug** toggle on (or
   `?debug=1`) → the tagged play-by-play; the **Python process stdout**; the **stats HUD**
   (watch `recoveries`, `dropped`, RTT); and REST (`curl …/demo/capabilities`, `…/streams`).
   The human can literally read a `[rfb:stall]` line to the agent.
3. **Hypothesize + instrument.** The agent adds/opens a log at the suspect seam and saves —
   HMR/reload applies it with no restart. The human re-triggers.
4. **Fix.** Once the failure is visible in the logs, apply the fix; the same loop confirms it.
5. **Lock it in.** For logic bugs, add a headless test that *simulates the trigger* (unit or
   Playwright) so the fix can't silently regress — SwiftShader won't catch HW-specific stalls.
6. **Tear down.** `Ctrl-C` cleanly stops Vite + uvicorn.

### Anti-patterns

- **Silent catches.** A `catch {}` with no emit is how the original bug hid for so long.
- **Ungated `console.log` in hot paths.** Gate behind the debug flag; keep `error` always-on.
  Littered logs get deleted wholesale, taking the useful ones with them.
- **Trusting the headless e2e for hardware paths.** SwiftShader is software; simulate the
  trigger instead of assuming coverage.
- **One-sided fixes to two-party deadlocks.** Add the symmetric backstop (rule 4).
- **Debugging through the built bundle.** Use `--dev` (source + HMR); the committed
  `static/` bundles are for shipping, not for iterating.

## Map

| Concern | Where |
| --- | --- |
| Tagged, gated logger | `widgets/src/debug.ts` |
| Worker play-by-play + debug toggle plumbing | `widgets/src/worker/entry.ts`, `widgets/src/types.ts` |
| Observable decode errors, fatal-config surface | `widgets/src/worker/videoDecode.ts` |
| Stall watchdog (pure, testable) | `widgets/src/worker/stallWatchdog.ts` (+ `tests/unit/stallWatchdog.test.ts`) |
| Server backstops (`decoder_reset`, inflight timeout) | `src/pdum/rfb/session.py` (+ `tests/test_session.py`) |
| Live-reload dev loop (`--dev`, `--open`, free port) | `src/pdum/rfb/demo_server.py`, `src/pdum/rfb/cli.py` |
| Skill entry point | `.claude/skills/frontend-debugging/SKILL.md` |
