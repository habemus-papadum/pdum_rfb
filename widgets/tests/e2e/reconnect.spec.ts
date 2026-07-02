import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

import { expect, test } from "@playwright/test";

// Auto-reconnect: kill the streaming server mid-stream and prove the client rebuilds the
// WebSocket on its own (backoff + re-handshake) and resumes decoding — no page refresh.
//
// This spec owns its OWN server on a separate port (the shared Playwright webServer on 8770 is
// managed by Playwright and can't be restarted from here). We spawn `pdum.rfb.server`, kill it,
// and restart it on the same port.
const PORT = 8771;
const WS = `ws://127.0.0.1:${PORT}`;
const HEALTH = `http://127.0.0.1:${PORT}/health`;
const REPO_ROOT = path.resolve(process.cwd(), ".."); // playwright runs from widgets/

type RfbWin = {
  __rfb?: { stats(): { framesDisplayed: number }; state(): string };
};

function startServer(): ChildProcess {
  // `detached: true` gives the child its own process group so we can kill the WHOLE group —
  // `uv run` forks a python child, and killing only `uv` would orphan the server on the port.
  return spawn(
    "uv",
    ["run", "python", "-m", "pdum.rfb.server", "--test-pattern", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: REPO_ROOT, stdio: "ignore", detached: true },
  );
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(HEALTH)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server on ${PORT} never became healthy`);
}

async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return;
  await new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    try {
      process.kill(-proc.pid, "SIGKILL"); // negative pid = the whole process group (uv + python)
    } catch {
      proc.kill("SIGKILL"); // fallback if the group is already gone
    }
  });
}

test("client auto-reconnects and resumes decoding after the server restarts mid-stream", async ({ page }) => {
  let server = startServer();
  try {
    await waitForHealth();
    await page.goto(`/?ws=${encodeURIComponent(WS)}&transport=image`);

    // Streaming to begin with.
    await page.waitForFunction(() => ((window as unknown as RfbWin).__rfb?.stats().framesDisplayed ?? 0) > 2, undefined, {
      timeout: 20_000,
    });
    const before = await page.evaluate(() => (window as unknown as RfbWin).__rfb?.stats().framesDisplayed ?? 0);

    // Drop the server: the socket closes and the client must enter its reconnect loop.
    await stop(server);
    await page.waitForFunction(
      () => {
        const s = (window as unknown as RfbWin).__rfb?.state();
        return s === "reconnecting" || s === "connecting" || s === "closed";
      },
      undefined,
      { timeout: 10_000 },
    );

    // Bring the server back on the same port; the client reconnects (backoff) and the new
    // session sends a keyframe first, so framesDisplayed must climb past the pre-kill count.
    server = startServer();
    await waitForHealth();
    await page.waitForFunction(
      (n) => ((window as unknown as RfbWin).__rfb?.stats().framesDisplayed ?? 0) > n + 3,
      before,
      { timeout: 25_000 },
    );

    const after = await page.evaluate(() => (window as unknown as RfbWin).__rfb?.stats().framesDisplayed ?? 0);
    expect(after).toBeGreaterThan(before + 3);

    // And it settled back into a live connection.
    const state = await page.evaluate(() => (window as unknown as RfbWin).__rfb?.state());
    expect(["open", "negotiated"]).toContain(state);
  } finally {
    await stop(server);
  }
});
