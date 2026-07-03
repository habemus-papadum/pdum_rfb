// Mode B (frame-as-texture), WebGL2. Keeps the current decoded frame uploaded into a texture
// in the CALLER's WebGL2 context — the caller then samples `.texture` in its own scene
// (minimap, overlay, blends). This is the "own the present texture" model, the useful cousin
// of "decode into my memory" (see docs/proposals/active/client_display_backend.md §5–6).
//
// Orientation contract: the texture's UV origin (0,0) is the frame's TOP-LEFT pixel and v
// increases toward the frame bottom (`texImage2D` with FLIP_Y off puts frame-row-0 at t=0 for
// every source type — the only cross-type-consistent choice; see §7.1). The caller maps that
// into its own geometry.

/** Uploads decoded frames into a WebGLTexture the caller samples. Runs on the caller's thread
 *  in the caller's context; `upload()` TAKES OWNERSHIP of the frame (copies then closes it). */
export class WebglFrameTexture {
  readonly kind = "webgl" as const;
  /** The live texture — sample this in your shaders. Stable across frames (re-uploaded). */
  readonly texture: WebGLTexture;
  /** Current frame size (frame px), for the caller's UV / aspect math. */
  frameW = 0;
  frameH = 0;

  constructor(private gl: WebGL2RenderingContext) {
    const tex = gl.createTexture();
    if (!tex) throw new Error("WebglFrameTexture: createTexture failed");
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  upload(src: VideoFrame | ImageBitmap, frameW: number, frameH: number): void {
    const gl = this.gl;
    try {
      this.frameW = frameW;
      this.frameH = frameH;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      // FLIP_Y off: consistent frame-row-0 -> t=0 for ImageBitmap AND VideoFrame (FLIP_Y is
      // ignored for ImageBitmap anyway — see §7.1).
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } finally {
      src.close(); // took ownership; the copy above is synchronous
    }
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
