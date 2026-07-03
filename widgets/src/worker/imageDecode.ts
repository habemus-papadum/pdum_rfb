// Image path: decode an image_frame to an ImageBitmap and hand it to the frame sink. Always
// available headlessly (createImageBitmap works in every modern browser/worker).

import type { ImageFrameHeader } from "../protocol";
import type { FrameSink } from "./frameSink";

export async function decodeImageFrame(
  sink: FrameSink,
  header: ImageFrameHeader,
  payload: Uint8Array,
): Promise<void> {
  // Copy into a fresh ArrayBuffer-backed view (Blob requires a non-shared buffer).
  const blob = new Blob([new Uint8Array(payload)], { type: header.mime });
  const bitmap = await createImageBitmap(blob);
  // The sink takes ownership of the bitmap (copies+closes for present, transfers for feed).
  sink.draw(bitmap, bitmap.width, bitmap.height);
}
