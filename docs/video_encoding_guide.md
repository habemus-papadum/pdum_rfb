# A working engineer's guide to modern video encoding

*Written for a competent engineer — scientific, systems, or ML — who has never had
reason to learn how `H.264`, `YCbCr`, or `4:2:0` actually work, and now needs to
reason about them to design or extend a remote-framebuffer system. It assumes you're
comfortable with linear algebra, signals, and systems thinking, but assumes **no**
prior codec knowledge. Nothing here is specific to this library until §12, which maps
the concepts onto the actual modules.*

!!! note "How to read this"
    §1–§2 are the mental model and the design axes — read those first. §3–§9 are the
    per-axis deep dives. §10 is the latency budget, §11 the browser decode side, §12
    maps it to this codebase, §13 is a glossary you can jump to, and the appendix has
    the math. You do **not** need to read linearly.

---

## 1. The one-paragraph mental model

A video encoder is a **lossy compressor for a sequence of images** that works by
removing four kinds of redundancy: **spatial** (neighboring pixels are similar),
**temporal** (consecutive frames are similar), **perceptual** (your eye is less
sensitive to color detail and to high-frequency error than to brightness), and
**statistical** (some symbols are more common than others, so code them shorter).
Everything else — frame types, quantization, color subsampling, rate control — is
machinery for spending a **bit budget** to minimize **visible error**. That trade-off
has a name, *rate–distortion optimization*, and it is the whole game:

$$ \min_{\text{coding choices}} \; J = D + \lambda R $$

where $D$ is distortion (how wrong the reconstructed pixels are), $R$ is rate (bits
used), and $\lambda$ is a knob that says how many bits a unit of quality is worth.
Every parameter you'll set in §8's glossary is, under the hood, nudging $\lambda$ or
constraining $R$.

For a **remote framebuffer** the content is *synthetic* (UI, text, plots, 3-D
renders), the loop is *interactive* (latency matters more than for movies), and the
cadence is *bursty* (sometimes 120 fps of motion, sometimes one frame every 30 s).
Those three facts break most defaults tuned for streaming film, and knowing *why* is
the point of this guide.

---

## 2. The design axes: what you actually have to decide

When you design a remote-framebuffer video path, you are making ten decisions. The
rest of the guide is one section per cluster.

| # | Axis | The question | Where it bites |
|---|------|--------------|----------------|
| 1 | **Codec** | H.264 / HEVC / AV1 / VP9? | Compatibility vs efficiency vs CPU |
| 2 | **Bitstream form** | Annex B vs AVCC; elementary vs muxed | Whether the browser can even decode it |
| 3 | **Frame structure** | I/P/B frames, GOP length, keyframe cadence | **Latency** and error recovery |
| 4 | **Rate control** | CQP / CRF / CBR / VBR + a buffer model | Bitrate stability, quality consistency |
| 5 | **Quality/speed** | preset, tune, QP | Encoder CPU vs bits-per-quality |
| 6 | **Color** | space, primaries, transfer, matrix, range, subsampling, bit depth | Correct color, text sharpness, HDR |
| 7 | **Resolution** | fixed vs dynamic; who owns size | Encoder rebuilds, scaling artifacts |
| 8 | **Hardware vs software** | x264 vs NVENC vs VideoToolbox | Latency, quality, portability |
| 9 | **Resilience** | packet loss, backpressure, keyframe-on-demand | Robustness on a lossy link |
| 10 | **Timing** | PTS/DTS, monotonic clocks, A/V-style sync | Replay, recording, correctness |

A useful reframing: **items 3, 4, 8, 10 are about *latency and control*; items 1, 2,
5 are about *compatibility and efficiency*; item 6 is about *correctness of what the
user sees*; items 7, 9 are about *robustness*.** Most people underestimate #6 and #3.

---

## 3. How lossy image compression works (the intra path)

Start with a single frame, because every video codec compresses at least some frames
as standalone images (those are **I-frames**), and the same machinery is reused for
the *residuals* of predicted frames.

The classic block-transform pipeline (JPEG, and the intra path of H.264/HEVC/AV1):

```
 pixels ─► color convert ─► split into blocks ─► predict ─► transform ─► quantize ─► entropy code ─► bits
 (RGB)     (to YCbCr,        (8×8 / 16×16 /      (guess     (DCT-like:  (÷ step,     (CABAC/CAVLC:
           subsample          4×4 …)             block from  concentrate rounding =   common
           chroma)                               neighbors)  energy in    the ONLY    symbols →
                                                             few coeffs)  lossy step)  short codes)
```

**Blocks.** The frame is tiled into blocks (H.264: *macroblocks* of 16×16, subdivided
to 4×4; HEVC: *CTUs* up to 64×64; AV1: *superblocks* up to 128×128). Compression
decisions are per-block, which is why you sometimes see *blocking* artifacts on hard
frames — the blocks are literally the unit of error.

**Intra prediction.** Before transforming, the encoder predicts a block from its
already-decoded neighbors (e.g. "this block is mostly a smooth continuation of the
pixels above and to the left") and only codes the **residual** (actual − predicted).
Flat regions predict almost perfectly, so they cost almost nothing.

**The transform.** Each block's residual is run through a **DCT-like** transform (a
discrete cosine transform, or in modern codecs an integer approximation of it). This
is the conceptual heart. A 2-D DCT expresses an $N\times N$ block as a sum of cosine
*basis patterns* of increasing frequency:

$$ F(u,v) = \frac{1}{4} C(u)C(v) \sum_{x=0}^{7}\sum_{y=0}^{7} f(x,y)\,
\cos\!\Big[\frac{(2x{+}1)u\pi}{16}\Big]\cos\!\Big[\frac{(2y{+}1)v\pi}{16}\Big] $$

The point isn't the formula, it's the *consequence*: **natural-image energy piles up
in the low-frequency coefficients** (top-left of the block), and the high-frequency
coefficients are usually near zero. So you've turned "64 roughly-equal pixel values"
into "a few big numbers and a lot of near-zeros" — which compresses beautifully.

**Quantization — the only lossy step.** Each transform coefficient is divided by a
**quantization step** $Q$ and rounded:

$$ \hat{F}(u,v) = \operatorname{round}\!\Big(\frac{F(u,v)}{Q}\Big) $$

Large $Q$ ⇒ more coefficients round to zero ⇒ fewer bits ⇒ more error. This is the
knob **QP** ("quantization parameter") exposes. In H.264, QP runs 0–51 and the step
*doubles every 6 QP* (it's logarithmic), so QP 28→34 roughly halves the bitrate and
visibly softens the image. Everything upstream (prediction, transform) is
mathematically reversible; only quantization throws information away.

**Entropy coding.** The quantized coefficients are losslessly packed with an entropy
coder — **CAVLC** (simpler, faster) or **CABAC** (context-adaptive binary arithmetic
coding, ~10–15 % smaller, more CPU). This is where "statistical redundancy" is
removed. It approaches the Shannon limit $H = -\sum_i p_i \log_2 p_i$ bits/symbol.

**Deblocking.** After reconstruction the decoder runs an in-loop **deblocking filter**
to smooth block edges. It's *in-loop* (applied before the frame is used as a
reference) so the encoder and decoder stay in lock-step.

!!! tip "Why this matters for screen content"
    This whole pipeline is tuned for *photographic* frequency statistics. Text, sharp
    UI edges, and single-pixel lines are **high-frequency** — exactly what
    quantization discards first. That's why crisp text over H.264 can shimmer or
    smear, and why §6.6 and §9 exist.

---

## 4. Frame types, GOPs, and why latency lives here

Video adds the temporal axis: most frames are coded as **differences** from other
frames.

- **I-frame (Intra).** Self-contained; decodable alone; big (it's a whole JPEG-ish
  image). Random-access points are built from these.
- **P-frame (Predicted).** Coded as motion-compensated difference from *earlier*
  frame(s). Small. The encoder finds, for each block, a **motion vector** pointing at
  a similar block in a reference frame and codes only the residual.
- **B-frame (Bi-directional).** Predicted from *both* earlier **and later** frames.
  Smallest of all — but to encode/decode one you need a *future* frame, which means
  frames are **reordered**, which means **latency**. (See below.)

**IDR vs plain I.** An **IDR** (Instantaneous Decoder Refresh) frame is an I-frame
that *also* flushes the reference buffers: nothing after it may reference anything
before it. That's what makes it a safe **random-access / recovery point**. A bare
I-frame is intra-coded but later frames might still reference across it. When this
guide (and this codebase) says "keyframe," it means IDR.

**GOP (Group of Pictures).** The repeating structure between keyframes, e.g.
`IBBPBBPBBP…`. **GOP length** = keyframe interval. Long GOP = better compression
(more frames amortize the expensive I-frame) but slower recovery from loss and slower
seek. A **closed GOP** doesn't reference across its boundary; an **open GOP** may.

**Decode order vs display order — the B-frame latency tax.** With B-frames, the
encoder must emit frames in *decode* order, not *display* order, so the decoder has
the references it needs before it needs them:

```
display order:  I  B  B  P  B  B  P
decode order:   I  P  B  B  P  B  B      ← the P is sent BEFORE the B's that display first
                   ▲
                   the decoder now holds a frame it can't show yet → buffering → latency
```

This is why **interactive, low-latency systems disable B-frames entirely.** With no
B-frames, *decode order == display order*, there is no reorder buffer, and each
encoded frame can be displayed the instant it's decoded. It also gives you a clean
invariant: a FIFO of frame sequence numbers exactly matches displayed frames — which
is how this codebase attributes "displayed" ACKs (see §12).

**Reference frames & `max_ref`.** P/B frames can reference more than one prior frame;
more references = marginally better compression = more encoder memory/CPU and more
state to lose on a dropped packet. Low-latency configs keep this small (often 1).

**Keyframe cadence & keyframe-on-demand.** Two forces:

1. A periodic IDR (say every 1–2 s) lets a newly-joined or desynced client recover.
2. But IDRs are big; on a bursty/interactive stream you don't want them on a timer
   wasting bits during stillness.

The resolution is **on-demand keyframes**: send an IDR when a *new* client connects,
when the client falls behind and you had to drop delta frames (see §9), or when the
resolution changes (§7) — plus a slow periodic safety net. This codebase does exactly
this.

---

## 5. Rate control: turning "quality" into "bits/second"

Quantization sets *quality per block*; **rate control** decides QP over time to hit a
*bitrate or quality target*. The modes:

| Mode | You specify | Behavior | Good for |
|------|-------------|----------|----------|
| **CQP** | a fixed QP | constant quantization, wildly varying bitrate | analysis, lowest latency, simplest |
| **CRF** | a quality factor (x264: 0–51, ~18–28 typical) | constant *perceived* quality, bitrate floats | archival / VOD; **not** for fixed pipes |
| **ABR / VBR** | an average bitrate | hits an average, lets peaks vary | general streaming |
| **CBR** | a constant bitrate | fills the pipe evenly | fixed-bandwidth links, live |
| **Capped CRF** | CRF + a max bitrate | quality-targeted but bounded | good default for adaptive live |

**CRF explained** (because it's the most confusing): CRF targets *constant quality* by
spending more bits on hard frames and fewer on easy ones — the opposite of CBR. A
CRF-encoded static screen costs almost nothing; a CRF-encoded video of noise costs a
fortune. Great for "look consistent," bad for "never exceed X Mbps."

**VBV / HRD — the buffer model.** A decoder has a finite input buffer. The **Video
Buffering Verifier** (VBV, part of the Hypothetical Reference Decoder) is a
constraint: *the bitstream must never overflow or underflow a buffer of size
`vbv-bufsize` drained at `vbv-maxrate`.* You set these to bound **peak** bitrate and
thus **latency**: a smaller VBV buffer means the encoder can't "save up" a huge frame,
so end-to-end delay is more predictable. For interactive streaming you want a small
VBV buffer (≈ one frame's worth) and often CBR-ish behavior.

**Adaptive quality.** On a real link, bandwidth and round-trip time vary. A controller
watches feedback (ACK RTT, decode-queue depth, drop counts) and retunes the target
bitrate (and sometimes fps) up or down. That's a control loop sitting *on top of* rate
control — this codebase has one (`adaptive.py`).

---

## 6. Color — the axis everyone under-invests in

This is the section most people skip and then spend a week debugging "why is my red
slightly orange / my text fringed / my gradient banded." Color is **five independent
choices**, and a video bitstream signals four of them explicitly.

### 6.1 Why RGB is (almost) never sent

Displays are RGB, but codecs compress **YCbCr** (often loosely called "YUV"): one
**luma** channel $Y'$ (brightness) and two **chroma** channels $C_b, C_r$
(blue-difference, red-difference). Two reasons:

1. **Decorrelation.** RGB channels are highly correlated (a bright pixel is bright in
   all three). $Y'C_bC_r$ concentrates almost all the energy in $Y'$, so the chroma
   channels are cheap.
2. **Perceptual.** Human vision has far more **luma** acuity than **chroma** acuity.
   You can throw away most of the color *resolution* and barely notice — which leads
   directly to subsampling (§6.2).

The (gamma-encoded) BT.709 conversion, for intuition:

$$
\begin{aligned}
Y' &= 0.2126\,R' + 0.7152\,G' + 0.0722\,B' \\
C_b &= \tfrac{B' - Y'}{1.8556}, \qquad
C_r = \tfrac{R' - Y'}{1.5748}
\end{aligned}
$$

The primes mean "gamma-encoded" (§6.4). Note the luma weights: green dominates
brightness, blue barely contributes — matching the eye's cone sensitivity.

### 6.2 Chroma subsampling — the $J{:}a{:}b$ notation

Because chroma is perceptually cheap, encoders **subsample** it: store full-resolution
luma but reduced-resolution color. The notation is a $4\times2$ sampling region
$J{:}a{:}b$ where $J=4$ is the width, $a$ = chroma samples in the top row, $b$ = chroma
samples in the bottom row.

```
4:4:4  every pixel has its own chroma      Y●●●●  Cb●●●●  Cr●●●●   (no color loss)
       (full color; RGB-equivalent)        Y●●●●  Cb●●●●  Cr●●●●

4:2:2  chroma halved horizontally          Y●●●●  Cb●─●─  Cr●─●─   (broadcast)
                                           Y●●●●  Cb●─●─  Cr●─●─

4:2:0  chroma halved both ways             Y●●●●  Cb●─●─  Cr●─●─   (the web default —
       (¼ the chroma samples)              Y●●●●  Cb────  Cr────    ¼ chroma resolution)
```

**4:2:0 is the near-universal default** (H.264 Baseline/Main/High, WebCodecs "avc1",
NVENC's fast path, this codebase's NV12 GPU path). For film it's invisible. For a
**remote framebuffer it's the single biggest quality trap**: colored text, thin
colored lines, and saturated UI edges have *high-frequency chroma*, and 4:2:0 blurs
color across a 2×2 block → visible **color fringing** on e.g. red-on-black text.
**4:4:4** (H.264 High 4:4:4 profile, or the image path) fixes it at a bitrate/CPU
cost. Knowing this is why a system might route "still, text-heavy" frames through a
lossless image path and "motion" through 4:2:0 H.264.

**NV12** is a specific memory layout of 4:2:0: a full-res $Y'$ plane followed by a
single interleaved $C_bC_r$ plane at quarter resolution. It's what GPUs and hardware
encoders want, which is why the zero-copy path produces it.

### 6.3 The three signaling axes: primaries, transfer, matrix

A pixel value like `(0.8, 0.1, 0.1)` is meaningless without knowing **what color that
is** and **what the numbers mean**. A bitstream answers this with three code points
(defined in ITU-T H.273 / ISO 23001-8), plus a range flag:

- **Color primaries** — *which* red/green/blue (the gamut triangle on the chromaticity
  diagram). BT.709 (HD/sRGB gamut), Display P3 (wider, Apple), BT.2020 (very wide,
  HDR).
- **Transfer characteristics** — the **gamma / EOTF**: the nonlinear mapping between
  stored code values and light. sRGB, BT.709, PQ (HDR), HLG (HDR).
- **Matrix coefficients** — the $R'G'B' \leftrightarrow Y'C_bC_r$ mixing matrix used in
  §6.1 (BT.709 vs BT.601 vs BT.2020, or *identity* = keep RGB, used by 4:4:4 RGB).
- **Range** — `full` (0–255 for 8-bit) vs `limited`/`studio` (luma 16–235). **Getting
  this wrong is the classic "washed-out blacks / crushed whites" bug**: full-range
  content decoded as limited (or vice-versa) shifts every level.

The code points you'll actually see (H.273 numeric ↔ WebCodecs string):

| Axis | Meaning | H.273 code | WebCodecs string |
|------|---------|-----------|------------------|
| primaries | BT.709 / sRGB | 1 | `bt709` |
| primaries | Display P3 (P3-D65) | 12 | `smpte432` |
| primaries | BT.2020 (HDR) | 9 | `bt2020` |
| transfer | BT.709 | 1 | `bt709` |
| transfer | sRGB (IEC 61966-2-1) | 13 | `iec61966-2-1` |
| transfer | PQ (SMPTE ST 2084) | 16 | `pq` |
| transfer | HLG (BT.2100) | 18 | `hlg` |
| matrix | Identity (RGB) | 0 | `rgb` |
| matrix | BT.709 | 1 | `bt709` |
| matrix | BT.2020 non-const-luma | 9 | `bt2020-ncl` |
| range | full / limited | flag | `fullRange: true/false` |

!!! warning "The insight that trips up everyone: “sRGB over H.264” is a lie of convenience"
    H.264 does **not** carry RGB or an "sRGB" pixel format. It carries **YCbCr 4:2:0**
    with *signaling*. "sRGB video" really means *primaries = BT.709, transfer = sRGB
    (or BT.709), matrix = BT.709, limited or full range* — and the decoder converts
    back to RGB using exactly those tags. So a color space isn't a *format* you feed
    the encoder; it's **metadata** you attach so the far end reconstructs the same
    light. Display P3 SDR is expressible the same way (primaries=12, transfer=13,
    matrix=1). This is why "does H.264 even support sRGB?" is the wrong question — the
    right one is "are the four color tags set correctly end-to-end?"

### 6.4 Gamma / transfer functions, briefly

Light is linear; perception is not; storage should match perception to use bits well.
A **transfer function** (a.k.a. EOTF/OETF, "gamma") maps between them. sRGB's is
piecewise, but approximately $V_{\text{stored}} \approx L_{\text{linear}}^{1/2.2}$.
This is why you must never blend, resize, or average pixels in *gamma* space and
expect physically correct results (a real gotcha if you resample frames before
encoding — do it in linear light or accept slightly wrong midtones).

For **HDR**, the transfer function changes qualitatively. **PQ** (Perceptual
Quantizer, ST 2084) maps code values to *absolute* luminance up to 10 000 nits:

$$ L = 10000 \left( \frac{\max(V^{1/m_2} - c_1,\,0)}{c_2 - c_3 V^{1/m_2}} \right)^{1/m_1} $$

with the standard constants $m_1,m_2,c_1,c_2,c_3$. **HLG** (Hybrid Log-Gamma) is
*relative* and backward-compatible with SDR displays. You don't need the constants;
you need to know HDR = *different transfer + wider primaries (BT.2020) + usually 10-bit
+ metadata*, which is why it's a whole separate project (§6.5).

### 6.5 Bit depth and HDR

**Bit depth** is bits per channel: 8-bit (0–255) is SDR standard; 10-bit (0–1023) is
required for HDR to avoid **banding** — visible steps in smooth gradients, because 256
levels aren't enough to sample a high-dynamic-range curve smoothly. 10-bit needs a
different profile (H.264 High 10, HEVC Main 10, AV1) *end to end*: encoder, the pixel
format (P010 instead of NV12), the decoder, and a 10-bit-capable compositor. Even on
SDR, 10-bit encoding reduces banding on gradients — a real win for scientific
colormaps — at a modest cost. **Banding on a smooth plot is the SDR symptom that makes
people want 10-bit.**

### 6.6 What this means for a remote framebuffer

- Default (BT.709 primaries, sRGB/709 transfer, BT.709 matrix, 4:2:0, 8-bit) is fine
  for photos and 3-D renders, **risky for crisp colored text/UI** (subsampling) and
  **for smooth scientific gradients** (8-bit banding).
- Wide gamut (Display P3) is *free-ish*: it's SDR, 8-bit, expressible in the same VUI,
  supported by WebCodecs and `display-p3` canvases. Worth doing.
- 4:4:4 and 10-bit each fix a specific artifact (fringing / banding) at real cost and
  reduced hardware support — pick them per-content, not globally.

---

## 7. Resolution & dynamic resize

Encoders are **fixed-resolution** objects: an H.264 stream declares its dimensions in
the **SPS** (§8) and every frame must match. Changing resolution therefore means
**tearing down and rebuilding the encoder** and emitting a fresh IDR so the decoder
can `configure()` to the new size. Consequences:

- A resize is *never* free — it's a keyframe (a bitrate spike) plus encoder init.
- Scaling itself (if you downscale a 4K render to a 1080p stream) is a resampling step
  with its own quality choices (do it in linear light; use a decent filter).
- **Who owns the size** is a system-design decision (publisher-authoritative vs
  match-the-client). See the companion doc `sizing_dpr_color.md`.

---

## 8. Encoder parameters — the annotated glossary

The knobs you'll set on `libx264` (via PyAV), NVENC, or VideoToolbox, grouped by what
they *do*. Names vary by encoder; the *concept* is what matters.

**Structure / latency**

- **`profile`** — a feature tier the decoder must support. H.264: *Baseline*
  (no B-frames/CABAC, most compatible), *Main*, *High* (best 8-bit 4:2:0), *High
  4:4:4* (no chroma subsampling), *High 10* (10-bit). The browser advertises which it
  can decode; you must not exceed it.
- **`level`** — a numeric ceiling (e.g. `4.1`) bounding resolution×fps×bitrate. `4.1`
  ≈ 1080p30. The decoder gates on this.
- **`gop` / `keyint`** — max frames between IDRs (keyframe interval).
- **`min-keyint`** — minimum spacing between IDRs.
- **`bframes`** — number of consecutive B-frames. **`0` for interactive.**
- **`ref` / `max_ref_frames`** — how many prior frames P/B may reference.
- **`slices`** — split a frame into independently-decodable slices (loss resilience,
  slice-threading without frame-reorder latency).

**Rate control** (see §5)

- **`bitrate` / `maxrate` / `bufsize`** — target/peak/VBV-buffer. Small `bufsize` ⇒
  lower, more predictable latency.
- **`qp` / `crf` / `cq`** — constant-quantizer / constant-quality knobs (lower = better
  = bigger).
- **`rc` mode** — `cbr` / `vbr` / `cqp` / `crf` selection.
- **`qmin` / `qmax`** — clamp the quantizer range rate control may use.

**Speed / quality**

- **`preset`** — the master speed↔efficiency dial. x264: `ultrafast … placebo`.
  A *faster* preset uses **more bits for the same quality** (it does less searching);
  a *slower* preset is smaller but costs CPU. For live low-latency you sit near
  `ultrafast`/`veryfast`. NVENC has its own `p1…p7` presets.
- **`tune`** — content/goal preset. **`zerolatency`** is the important one: disables
  lookahead and B-frames, enables sliced threading — trading a little efficiency for
  minimal delay. Others: `film`, `grain`, `animation`, `ssim`, `psnr`.
- **`lookahead` / `rc-lookahead`** — how many future frames rate control may peek at.
  Great for quality, **adds latency** — off for interactive.
- **`aq-mode` / `aq-strength`** — *adaptive quantization*: redistribute bits toward
  visually important (often flat/dark) regions to fight banding/blocking.
- **`psy` / `psy-rd`** — psychovisual optimization: keep the image *looking* sharp/
  detailed even if that slightly worsens PSNR (because your eye prefers it).

**Color** (see §6)

- **`pix_fmt`** — pixel format/layout: `yuv420p` / `nv12` (4:2:0), `yuv444p` (4:4:4),
  `p010` (10-bit).
- **`colorprim` / `transfer` / `colormatrix`** — the three VUI signaling tags.
- **`range`** — full vs limited.

**Entropy**

- **`coder` / `cabac`** — CABAC (smaller, more CPU) vs CAVLC (faster). Baseline
  profile forces CAVLC.

**Threading / delay**

- **`threads` / frame-vs-slice threads** — *frame* threading pipelines multiple frames
  and **adds latency**; *slice* threading parallelizes within a frame and doesn't.
- **`extra_output_delay` (NVENC)** — buffered output frames; **0** gives synchronous
  1-in-1-out, required when you must attribute each access unit to its source frame.

---

## 9. Bitstream formats, NAL units, and containers

Two representations of "the same" H.264 confuse everyone; getting it wrong means the
browser silently fails to decode.

**NAL units.** An H.264 bitstream is a sequence of **NAL** (Network Abstraction Layer)
units, each a typed chunk:

| NAL type | Name | What it is |
|---------|------|-----------|
| 7 | **SPS** (Sequence Parameter Set) | resolution, profile, color VUI — the "stream config" |
| 8 | **PPS** (Picture Parameter Set) | per-picture coding params |
| 5 | IDR slice | keyframe picture data |
| 1 | non-IDR slice | P/B picture data |
| 6 | SEI | optional metadata (e.g. HDR mastering info) |
| 9 | AUD | access-unit delimiter |

An **access unit (AU)** is all the NAL units for one displayed frame. SPS/PPS are the
*parameter sets* the decoder needs before any picture.

**Annex B vs AVCC — the trap.**

- **Annex B** — NAL units separated by **start codes** (`00 00 00 01`), parameter sets
  carried **in-band** (repeated before IDRs). This is the *elementary stream* form,
  what live/broadcast pipelines and **WebCodecs in Annex B mode** consume.
- **AVCC / "length-prefixed"** — each NAL prefixed by its **length**, parameter sets
  stored **out-of-band** in an `avcC` "extradata" box. This is the **MP4** form.

They are **not interchangeable byte-for-byte.** If you route H.264 through an MP4
muxer you get AVCC; feed that to an Annex-B decoder and it fails. This codebase emits
**Annex B only** and never muxes to MP4 — a hard invariant. The browser's
`VideoDecoder`, configured for Annex B, gets in-band SPS/PPS on every keyframe and
needs no `description`/extradata.

**Containers vs codecs.** MP4/WebM/MPEG-TS are *containers* (they carry codec
bitstreams + timing + audio + metadata). A remote framebuffer over WebSocket needs no
container — it frames each AU itself (here: a `uint32` length + JSON header +
raw bytes) and hands raw chunks to WebCodecs. Containers add latency and complexity
you don't want for a single low-latency video track.

---

## 10. Where latency actually comes from

For an interactive system, tally the delay sources — most are *choices*, not physics:

```
 render ─► color convert ─► ENCODE ─► network ─► jitter buffer ─► DECODE ─► composite ─► glass
             (RGB→NV12)     │                       │                          │
                            │                       │                          └─ vsync (≤16.7ms @60Hz)
                            ├─ B-frame reorder ⚑     └─ absorbs network jitter;
                            ├─ lookahead ⚑              bigger = smoother = laggier
                            ├─ frame-threading ⚑
                            └─ VBV buffer fill ⚑     ⚑ = latency you can remove by config
```

The **removable** ones (⚑) are exactly the low-latency recipe: **no B-frames, no
lookahead, slice (not frame) threading, small VBV buffer, `tune=zerolatency`,
synchronous encoder output.** The **irreducible** ones are one frame's worth of encode
+ decode + network RTT + one vsync. A well-configured H.264 interactive path adds
single-digit-to-low-tens of milliseconds on top of the network; a *default* film-tuned
config can add *hundreds* (multi-frame lookahead + reorder + big VBV). This is the
main reason to understand §4–§5.

**Backpressure & recovery (the resilience knot).** On a real link the client
sometimes can't keep up. If you keep sending **delta (P) frames** the client can't
decode in time, you strand it on references it will never catch up to. The correct
policy is **latest-frame-wins**: drop *un-encoded* frames when the client is behind,
and force the next sent frame to a **keyframe** (never drop already-encoded deltas,
which breaks the reference chain). New clients start on a keyframe; a desync requests
one. This is the same on-demand-keyframe machinery as §4, viewed from the network
side, and it's a core invariant of this codebase.

---

## 11. The decode side: WebCodecs in the browser

The browser half is small but has sharp edges:

- **`VideoDecoder`** — configured with `{ codec, codedWidth, codedHeight, description? }`.
  For Annex B you **omit `description`** (params are in-band). The `codec` string
  encodes profile+level, e.g. `avc1.42E01F` = Baseline/3.1.
- **`EncodedVideoChunk`** — one AU, typed `key` or `delta`, with a microsecond
  `timestamp`. A decoder **must start on a `key` chunk**; feed it a `delta` first and
  it errors — hence the client-side "keyframe gate" that drops deltas until the first
  IDR.
- **`isConfigSupported()`** — feature-detect before configuring (not every browser/OS
  decodes every profile, 4:4:4, 10-bit, or HDR). Gate the video path on it and fall
  back to the image path.
- **`VideoFrame.colorSpace`** — the decoder surfaces the signaled color tags; drawing
  to a canvas created with `{ colorSpace: 'display-p3' }` yields correct wide-gamut
  color. A plain canvas is sRGB.
- **`configure()` on resize** — a resolution change (new SPS) requires reconfiguring
  the decoder; the client compares `codedWidth/Height` and rebuilds.
- **Reordering** — with no B-frames, decoder output order = input order, so a simple
  FIFO of sequence numbers attributes decoded/displayed frames exactly. (B-frames
  would break this — another reason they're off.)

---

## 12. How this maps onto this codebase

The abstract choices above are made concretely here — this is your "where do I look"
table:

| Concept | Decision in this repo | Where |
|--------|------------------------|-------|
| Two transports | per-frame **image** (every frame a keyframe) *or* **H.264** | `encoders/image.py`, `encoders/h264_cpu.py` |
| Bitstream | **Annex B only**, never MP4/AVCC | `h264_cpu.py`, `docs/internals.md` |
| Frame structure | **no B-frames**, ~1 s IDR cadence, in-band SPS/PPS | `h264_cpu.py` low-latency config |
| Latency tune | `ultrafast` + `zerolatency` | `h264_cpu.py` |
| Keyframe policy | first-frame, on-resize, on-drop, on-request | `session.py` |
| Backpressure | **latest-frame-wins**, force keyframe after drop | `session.py`, `backpressure.ts` |
| Seq attribution | no-B-frames FIFO ⇒ `displayed:true` ACKs | `session.py`, `videoDecode.ts` |
| Color / NV12 | 4:2:0 NV12 for the zero-copy GPU path | `gpu.py`, `encoders/nvenc_*.py` |
| Timestamps | real monotonic PTS source→encoder→chunk | `types.py`, `session.py` |
| Hardware encode | NVENC (CUDA) and VideoToolbox (Metal) backends | `encoders/nvenc_*.py`, `packages/vtenc` |
| Capability gate | `VideoDecoder.isConfigSupported` before the video path | `capabilities.ts`, `videoDecode.ts` |
| Rate/quality control | adaptive bitrate+fps controller | `adaptive.py`, `metrics.py` |
| Color/DPR roadmap | descriptor + P3 + fit modes | `docs/proposals/active/sizing_dpr_color.md` |

If you remember one thing per section: **§4** no B-frames = no reorder latency;
**§5** small VBV = predictable latency; **§6** color is metadata, and 4:2:0 hurts
text; **§9** Annex B ≠ MP4; **§10** the low-latency recipe is mostly *turning defaults
off*.

---

## 13. Glossary

**4:2:0 / 4:2:2 / 4:4:4** — chroma subsampling ratios; 4:2:0 stores ¼ the color
resolution (web default), 4:4:4 stores full color. (§6.2)
**Access unit (AU)** — all NAL units for one displayed frame. (§9)
**Annex B** — elementary-stream H.264 with start codes + in-band SPS/PPS. (§9)
**AVCC** — length-prefixed H.264 with out-of-band `avcC` params (the MP4 form). (§9)
**B-frame** — bi-directionally predicted; smallest, but forces reorder ⇒ latency. (§4)
**Bitrate** — bits per second of encoded output. (§5)
**CABAC / CAVLC** — arithmetic vs variable-length entropy coders. (§3)
**CBR / VBR / CRF / CQP** — rate-control modes. (§5)
**Chroma / Luma** — color-difference ($C_b,C_r$) vs brightness ($Y'$) channels. (§6.1)
**Codec** — the compression standard (H.264/HEVC/AV1); distinct from a container. (§9)
**Container** — MP4/WebM/TS wrapper around codec data + timing. (§9)
**CTU / macroblock / superblock** — the per-codec block unit of coding. (§3)
**DCT** — discrete cosine transform; concentrates block energy in low frequencies. (§3)
**Deblocking filter** — in-loop smoothing of block edges. (§3)
**EOTF / OETF / transfer function / gamma** — code-value↔light mapping. (§6.4)
**Entropy coding** — lossless symbol packing toward the Shannon limit. (§3)
**GOP** — group of pictures between keyframes; its length is the keyframe interval. (§4)
**HDR / PQ / HLG** — high dynamic range and its two transfer functions. (§6.4–6.5)
**HRD / VBV** — buffer model constraining peak bitrate / latency. (§5)
**I / P / B frame** — intra / predicted / bi-predicted picture types. (§4)
**IDR** — keyframe that flushes references; a safe random-access/recovery point. (§4)
**Level** — decoder capability ceiling (resolution×fps×bitrate). (§8)
**Matrix coefficients** — the $RGB\leftrightarrow YCbCr$ mixing choice. (§6.3)
**Motion vector / motion compensation** — pointing a block at a similar block in a
reference frame and coding the residual. (§4)
**NAL unit** — a typed chunk of an H.264 bitstream (SPS/PPS/slice/SEI…). (§9)
**NV12** — a 4:2:0 memory layout (Y plane + interleaved CbCr plane) HW encoders want. (§6.2)
**Preset** — the speed↔compression-efficiency master dial. (§8)
**Primaries** — which RGB (the gamut); BT.709 / Display P3 / BT.2020. (§6.3)
**Profile** — decoder feature tier (Baseline/Main/High/High 4:4:4/High 10). (§8)
**PSNR / SSIM** — objective quality metrics (see appendix). (Appendix)
**PTS / DTS** — presentation vs decode timestamps; differ when B-frames reorder. (§4)
**QP / quantization step** — the quantizer; the one lossy control. (§3)
**Range (full/limited)** — 0–255 vs 16–235; mismatches wash out or crush levels. (§6.3)
**Rate–distortion** — the $J=D+\lambda R$ trade-off the whole encoder optimizes. (§1)
**Reference frame** — a prior frame P/B predict from. (§4)
**Residual** — actual minus predicted, the part that gets transformed+coded. (§3)
**SPS / PPS** — sequence/picture parameter sets (stream/picture config). (§9)
**Slice** — an independently-decodable region of a frame (resilience/threading). (§8)
**VUI** — Video Usability Information; carries the color signaling tags. (§6.3)
**WebCodecs** — the browser's low-level `VideoDecoder`/`VideoFrame` API. (§11)
**zerolatency** — an x264 tune that strips lookahead/B-frames for minimal delay. (§8)

---

## Appendix — the math, for the curious

**Distortion (MSE) and PSNR.** For an 8-bit reconstruction $\hat{x}$ of $x$ over $N$
pixels:

$$ \text{MSE} = \frac{1}{N}\sum_i (x_i - \hat{x}_i)^2, \qquad
\text{PSNR} = 10\log_{10}\!\frac{255^2}{\text{MSE}} \ \text{dB} $$

Higher PSNR = closer to the original. ~30 dB is mediocre, ~40 dB is good, ∞ is
lossless. PSNR correlates only loosely with *perceived* quality, which is why
**SSIM** (structural similarity, comparing local luminance/contrast/structure) and
psychovisual tuning exist — the encoder sometimes *lowers* PSNR to *raise* apparent
quality.

**Rate–distortion optimization (RDO).** For each coding choice (block size, mode,
motion vector, QP), the encoder evaluates

$$ J = D + \lambda R $$

and picks the minimum. $\lambda$ is tied to QP (roughly $\lambda \propto 2^{QP/3}$ in
H.264), so "quality" is really "how expensive I'm pretending bits are." This single
equation is why *faster presets cost more bits at equal quality* — they evaluate fewer
candidate $J$'s and settle for a worse minimum.

**Quantization step vs QP (H.264).** The step size grows geometrically:

$$ Q_\text{step}(\text{QP}) = Q_\text{step}(0)\cdot 2^{\text{QP}/6} $$

so every +6 QP doubles the step (≈ halves bitrate). That geometric spacing is why QP
is a *comfortable* linear-feeling knob despite quantization being multiplicative.

**Shannon bound (why entropy coding can't cheat).** No lossless coder beats the source
entropy $H(X) = -\sum_i p_i\log_2 p_i$ bits/symbol on average; CABAC just gets close to
it. All the *real* compression happened upstream, in prediction + transform +
quantization, which reshaped the symbol distribution to have low entropy in the first
place.

---

*See also:* `docs/proposals/active/sizing_dpr_color.md` (fit modes, DPR, and the color descriptor
this guide's §6 motivates), `docs/internals.md` (the concrete data flow and wire
protocol), and `docs/gpu_zerocopy.md` (the NV12 zero-copy encode path).
