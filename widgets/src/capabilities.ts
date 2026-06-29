// Capability probing. Runs inside the worker (WebCodecs + VideoDecoder are
// available in dedicated workers) before sending `hello`.

export const CAP_JPEG = "image/jpeg";
export const CAP_PNG = "image/png";
export const CAP_H264_ANNEXB = "webcodecs/h264-annexb";
export const DEFAULT_H264_CODEC = "avc1.42E01F";

export interface Capabilities {
  supported: string[];
  devicePixelRatio: number;
}

/** True if the platform's VideoDecoder reports support for `codec`. */
export async function isCodecSupported(codec: string, width = 1280, height = 720): Promise<boolean> {
  const VD = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
  if (!VD || typeof VD.isConfigSupported !== "function") return false;
  try {
    const res = await VD.isConfigSupported({ codec, codedWidth: width, codedHeight: height });
    return Boolean(res.supported);
  } catch {
    // isConfigSupported can throw on a malformed config, not just resolve false.
    return false;
  }
}

export interface ProbeOptions {
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  /** Force image-only capabilities (used by the image-path e2e). */
  imageOnly?: boolean;
}

/** Always advertises JPEG/PNG; adds H.264 if the decoder supports it. */
export async function probeCapabilities(opts: ProbeOptions = {}): Promise<Capabilities> {
  const supported = [CAP_JPEG, CAP_PNG];
  if (!opts.imageOnly && (await isCodecSupported(DEFAULT_H264_CODEC, opts.width, opts.height))) {
    supported.push(CAP_H264_ANNEXB);
  }
  return { supported, devicePixelRatio: opts.devicePixelRatio ?? 1 };
}
