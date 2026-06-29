import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { packBinaryMessage, unpackBinaryMessage } from "../../src/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures/protocol");

describe("binary envelope", () => {
  it("round-trips header and payload", () => {
    const header = { type: "image_frame", seq: 42, width: 1280, height: 720, mime: "image/jpeg" };
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const { header: h, payload: p } = unpackBinaryMessage(packBinaryMessage(header, payload));
    expect(h).toEqual(header);
    expect(Array.from(p)).toEqual(Array.from(payload));
  });

  it("handles a multibyte UTF-8 header (length in bytes)", () => {
    const header = { type: "image_frame", note: "café-🎞" };
    const { header: h } = unpackBinaryMessage(packBinaryMessage(header, new Uint8Array()));
    expect(h).toEqual(header);
  });

  it("handles a Uint8Array view with a nonzero byteOffset", () => {
    const packed = new Uint8Array(packBinaryMessage({ type: "x", seq: 1 }, new Uint8Array([9, 8, 7])));
    const padded = new Uint8Array(packed.length + 5);
    padded.set(packed, 5);
    const view = padded.subarray(5); // byteOffset === 5
    const { header, payload } = unpackBinaryMessage(view);
    expect(header).toEqual({ type: "x", seq: 1 });
    expect(Array.from(payload)).toEqual([9, 8, 7]);
  });

  it("throws on a truncated buffer", () => {
    const packed = new Uint8Array(packBinaryMessage({ type: "x" }, new Uint8Array([1, 2, 3])));
    expect(() => unpackBinaryMessage(packed.subarray(0, 6))).toThrow();
  });
});

describe("python parity fixtures", () => {
  const jsonFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

  it.each(jsonFiles)("matches python pack_binary_message for %s", (name) => {
    const expected = JSON.parse(readFileSync(join(fixturesDir, name), "utf-8"));
    const bin = readFileSync(join(fixturesDir, name.replace(/\.json$/, ".bin")));
    const arrayBuffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    const { header, payload } = unpackBinaryMessage(arrayBuffer);
    expect(header).toEqual(expected.header);
    expect(Buffer.from(payload).toString("hex")).toEqual(expected.payloadHex);
  });
});
