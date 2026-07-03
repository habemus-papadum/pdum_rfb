import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pickRecordingMimeType,
  RECORDING_UNSUPPORTED_MESSAGE,
  recordingSupported,
  startCanvasRecording,
} from "../../src/recording";

// The vitest environment is Node — no MediaRecorder / HTMLCanvasElement — so these tests cover
// the capability gates + MIME negotiation logic (the browser-only encode path is proven by the
// Playwright e2e, tests/e2e/recording.spec.ts).

afterEach(() => vi.unstubAllGlobals());

describe("recordingSupported", () => {
  it("is false without MediaRecorder / captureStream (Node)", () => {
    expect(recordingSupported()).toBe(false);
  });
});

describe("pickRecordingMimeType", () => {
  it("returns undefined without MediaRecorder", () => {
    expect(pickRecordingMimeType()).toBeUndefined();
    expect(pickRecordingMimeType("video/webm")).toBeUndefined();
  });

  it("honors the preferred list before the built-in defaults", () => {
    // Stub a MediaRecorder that only supports WebM (no MP4), with isTypeSupported truthiness.
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (t: string) => t.startsWith("video/webm"),
    });
    // A preferred MP4 is unsupported, so it falls through to the first supported WebM.
    expect(pickRecordingMimeType("video/mp4")).toBe("video/webm;codecs=vp9");
    // A supported preferred type wins outright.
    expect(pickRecordingMimeType("video/webm;codecs=vp8")).toBe("video/webm;codecs=vp8");
  });

  it("returns undefined when nothing is supported", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickRecordingMimeType()).toBeUndefined();
  });
});

describe("startCanvasRecording", () => {
  it("throws when the browser cannot record (guarded by recordingSupported)", () => {
    expect(() => startCanvasRecording({} as HTMLCanvasElement)).toThrow(/MediaRecorder/);
  });
});

describe("RECORDING_UNSUPPORTED_MESSAGE", () => {
  it("names the actionable alternative", () => {
    expect(RECORDING_UNSUPPORTED_MESSAGE).toContain("MainThreadPresentView");
  });
});
