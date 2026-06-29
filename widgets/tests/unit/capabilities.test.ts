import { afterEach, describe, expect, it, vi } from "vitest";

import { CAP_H264_ANNEXB, CAP_JPEG, CAP_PNG, probeCapabilities } from "../../src/capabilities";

afterEach(() => {
  // @ts-expect-error cleanup injected global
  delete globalThis.VideoDecoder;
  vi.restoreAllMocks();
});

function stubVideoDecoder(impl: () => Promise<{ supported: boolean }>) {
  // @ts-expect-error minimal stub
  globalThis.VideoDecoder = { isConfigSupported: vi.fn(impl) };
}

describe("probeCapabilities", () => {
  it("always advertises JPEG and PNG", async () => {
    const caps = await probeCapabilities();
    expect(caps.supported).toContain(CAP_JPEG);
    expect(caps.supported).toContain(CAP_PNG);
  });

  it("adds H.264 when the decoder supports it", async () => {
    stubVideoDecoder(async () => ({ supported: true }));
    const caps = await probeCapabilities();
    expect(caps.supported).toContain(CAP_H264_ANNEXB);
  });

  it("omits H.264 when the decoder reports unsupported", async () => {
    stubVideoDecoder(async () => ({ supported: false }));
    const caps = await probeCapabilities();
    expect(caps.supported).not.toContain(CAP_H264_ANNEXB);
  });

  it("omits H.264 when isConfigSupported throws", async () => {
    stubVideoDecoder(async () => {
      throw new Error("bad config");
    });
    const caps = await probeCapabilities();
    expect(caps.supported).not.toContain(CAP_H264_ANNEXB);
  });

  it("omits H.264 when imageOnly is requested", async () => {
    stubVideoDecoder(async () => ({ supported: true }));
    const caps = await probeCapabilities({ imageOnly: true });
    expect(caps.supported).not.toContain(CAP_H264_ANNEXB);
  });

  it("advertises image-only when VideoDecoder is absent", async () => {
    const caps = await probeCapabilities();
    expect(caps.supported).toEqual([CAP_JPEG, CAP_PNG]);
  });
});
