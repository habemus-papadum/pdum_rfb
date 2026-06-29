// Image path: decode an image_frame to an ImageBitmap and draw it. Always
// available headlessly (createImageBitmap works in every modern browser/worker).

import type { ImageFrameHeader } from "../protocol";
import type { Renderer } from "./renderer";

export async function decodeImageFrame(
  renderer: Renderer,
  header: ImageFrameHeader,
  payload: Uint8Array,
): Promise<void> {
  // Copy into a fresh ArrayBuffer-backed view (Blob requires a non-shared buffer).
  const blob = new Blob([new Uint8Array(payload)], { type: header.mime });
  const bitmap = await createImageBitmap(blob);
  try {
    renderer.draw(bitmap);
  } finally {
    bitmap.close(); // release promptly; ImageBitmap holds GPU/decoder resources
  }
}
