---
name: frontend-debugging
description: >
  Debug the pdum.rfb browser client (streaming framebuffer, Web Worker decoder) with a
  human in the loop. Use when a UI/streaming symptom is reported — black screen, frozen
  or stuttering video, decoder stalls, resize glitches, events not registering, controls
  not taking effect — and you need to reproduce it live and read the logs. Also the
  reference for how to instrument new client code so failures are observable.
---

# Frontend debugging (pdum.rfb client)

Full reference (patterns + rationale): `docs/agentic_frontend_debugging.md`. This is the
short procedure.

## Reproduce live

```bash
pdum-rfb demo --dev --open
```

`--dev` = Vite TS HMR + uvicorn Python reload (edits to either side apply with no restart);
`--open` opens the browser; the port is random (`--port N` to pin). The browser hits Vite,
which proxies REST + the framebuffer WS to Python.

## Read all four channels

1. **Browser console** with the demo **Debug** toggle on (or `?debug=1`): tagged play-by-play
   — `[rfb:worker|view|decode|stall|recover|ws]`. Ask the human to read the lines aloud.
2. **Python stdout**: the `pdum.rfb.demo` logs (stream/scene/backend changes, resets).
3. **Stats HUD**: watch `recoveries` (a decode stall was auto-healed), `dropped`, RTT, fps.
4. **REST**: `curl http://HOST:PORT/demo/capabilities`, `.../streams`, `.../metrics`.

## Loop

Reproduce → read the four channels → hypothesize → add/open a log at the suspect **seam**
(WS connect/close, `configure`, keyframe gate, decode, stall, recovery) → save (HMR applies
it) → re-trigger → fix → confirm in the same loop → `Ctrl-C` to tear down.

## Lock it in

Add a headless test that **simulates the trigger** — SwiftShader (the e2e decoder) is software
and won't reproduce hardware stalls. Prefer a pure unit test (see `StallWatchdog`) with an
injected clock/counters over relying on the real decoder. Then `pnpm -C widgets test` and
`pnpm -C widgets e2e`.

## When writing client code, make it debuggable

- Log at **seams**, gated behind the debug flag (`widgets/src/debug.ts` `makeLogger`); keep
  `error` always-on.
- **No silent catches / empty returns** — emit something on every failure path.
- Instrument the **absence of progress** (a watchdog), not just thrown errors.
- Fix two-party deadlocks at **both ends** (client recovery *and* a server backstop).
- Keep failure logic **pure + clock-injected** so it's unit-testable headlessly.

Do **not** modify version numbers or run `./scripts/release.sh` (see AGENTS.md).
