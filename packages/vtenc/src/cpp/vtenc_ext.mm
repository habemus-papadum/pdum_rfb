// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Nehal Patel / pdum.rfb contributors.
//
// vtenc_ext.mm — `pdum.vtenc._vtenc`: a thin pybind11 binding over Apple's
// VideoToolbox H.264 encoder (VTCompressionSession). The macOS counterpart of
// `pdum.nvenc` (NvEncoderCuda): it takes a host-visible NV12 frame and returns
// H.264 **Annex B** bytes, with no PyAV/ffmpeg. This is the *only* hand-written code
// in the package — there is no vendored SDK (VideoToolbox/CoreVideo/CoreMedia are
// system frameworks).
//
// Fixed-resolution NV12 in, Annex B out, one VTCompressionSession per instance.
//
// Pipeline (mirrors the project's NVENC invariants):
//   * low-latency rate control + RealTime + AllowFrameReordering=false  => no B-frames,
//     output order == input order;
//   * CompleteFrames after every EncodeFrame                            => synchronous
//     1-in-1-out (each encode() returns its own frame's access unit), required for the
//     session's seq attribution;
//   * SPS/PPS prepended on every IDR (in-band)                          => browser WebCodecs;
//   * 420v (video range) + BT.601 VUI                                   => matches the
//     gpu.rgb_to_nv12 limited-range kernel; no washout/hue shift.
//
// v1 input path: a host-visible (CPU/unified-memory) NV12 buffer is memcpy'd into an
// encoder-owned CVPixelBuffer. Wrapping MLX's unified-memory buffer as the CVPixelBuffer
// backing directly (true zero-copy) is a follow-up. See
// docs/mlx_metal_videotoolbox_encoder_design.md.

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <chrono>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>

namespace py = pybind11;

namespace {

const uint8_t kStartCode[4] = {0, 0, 0, 1};

inline double ms_since(std::chrono::steady_clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

// Per-encoder output sink. The VideoToolbox output callback runs on a VT-owned queue
// with no GIL, so it touches only this C++ struct (never CPython).
struct Sink {
    std::mutex mu;
    std::vector<uint8_t> pending;  // Annex B bytes for the frame(s) drained so far
    int sps_profile = -1, sps_constraint = -1, sps_level = -1;
    OSStatus last_status = noErr;
};

void append_nal(std::vector<uint8_t> &out, const uint8_t *nal, size_t len) {
    out.insert(out.end(), kStartCode, kStartCode + 4);
    out.insert(out.end(), nal, nal + len);
}

bool sample_is_keyframe(CMSampleBufferRef sb) {
    CFArrayRef att = CMSampleBufferGetSampleAttachmentsArray(sb, /*create=*/false);
    if (!att || CFArrayGetCount(att) == 0) return true;  // no attachments => sync sample
    CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(att, 0);
    CFBooleanRef notSync = (CFBooleanRef)CFDictionaryGetValue(d, kCMSampleAttachmentKey_NotSync);
    return (notSync == nullptr) || (CFBooleanGetValue(notSync) == false);
}

void output_cb(void *refcon, void * /*src*/, OSStatus status, VTEncodeInfoFlags flags,
               CMSampleBufferRef sb) {
    Sink *sink = static_cast<Sink *>(refcon);
    std::lock_guard<std::mutex> lk(sink->mu);
    if (status != noErr) {
        sink->last_status = status;
        return;
    }
    if ((flags & kVTEncodeInfo_FrameDropped) || sb == nullptr) return;  // dropped: no AU

    CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sb);
    int nalHeaderLen = 4;

    if (sample_is_keyframe(sb)) {
        // SPS/PPS live only in the format description; prepend them on every keyframe.
        size_t count = 0;
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, 0, nullptr, nullptr, &count,
                                                           &nalHeaderLen);
        for (size_t i = 0; i < count; i++) {
            const uint8_t *ps = nullptr;
            size_t psSize = 0;
            if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, i, &ps, &psSize, nullptr,
                                                                   nullptr) == noErr &&
                ps && psSize > 0) {
                append_nal(sink->pending, ps, psSize);
                if ((ps[0] & 0x1F) == 7 && psSize >= 4) {  // SPS: capture profile/level
                    sink->sps_profile = ps[1];
                    sink->sps_constraint = ps[2];
                    sink->sps_level = ps[3];
                }
            }
        }
    }

    // AVCC (length-prefixed) -> Annex B. GetDataPointer may be segmented, so copy the
    // whole thing into a contiguous staging buffer before walking NAL boundaries.
    CMBlockBufferRef bb = CMSampleBufferGetDataBuffer(sb);
    if (!bb) return;
    size_t total = CMBlockBufferGetDataLength(bb);
    std::vector<uint8_t> data(total);
    if (CMBlockBufferCopyDataBytes(bb, 0, total, data.data()) != noErr) return;
    size_t off = 0;
    while (off + (size_t)nalHeaderLen <= total) {
        uint32_t nalLen = 0;
        for (int b = 0; b < nalHeaderLen; b++) nalLen = (nalLen << 8) | data[off + b];
        off += nalHeaderLen;
        if (nalLen == 0 || off + nalLen > total) break;
        append_nal(sink->pending, data.data() + off, nalLen);
        off += nalLen;
    }
}

CFDictionaryRef make_cf_dict(const void **keys, const void **vals, CFIndex n) {
    return CFDictionaryCreate(nullptr, keys, vals, n, &kCFTypeDictionaryKeyCallBacks,
                              &kCFTypeDictionaryValueCallBacks);
}

void set_session_num(VTCompressionSessionRef s, CFStringRef key, int32_t v) {
    CFNumberRef n = CFNumberCreate(nullptr, kCFNumberSInt32Type, &v);
    VTSessionSetProperty(s, key, n);
    CFRelease(n);
}

}  // namespace

class VtEncoder {
public:
    VtEncoder(int width, int height, const std::string &codec, int fps, int gop, int bitrate,
              bool realtime, bool low_latency)
        : m_width(width), m_height(height), m_fps(fps > 0 ? fps : 30) {
        if (width <= 0 || height <= 0 || (width & 1) || (height & 1))
            throw std::invalid_argument("width/height must be positive and even (NV12)");
        if (codec != "h264")
            throw std::invalid_argument("only codec='h264' is supported in v1");

        // Source pixel-buffer attributes: 420v, IOSurface-backed.
        int32_t fmt = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
        CFNumberRef fmtNum = CFNumberCreate(nullptr, kCFNumberSInt32Type, &fmt);
        CFDictionaryRef ioSurf = make_cf_dict(nullptr, nullptr, 0);
        const void *sk[] = {kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferIOSurfacePropertiesKey};
        const void *sv[] = {fmtNum, ioSurf};
        CFDictionaryRef srcAttrs = make_cf_dict(sk, sv, 2);
        CFRelease(fmtNum);
        CFRelease(ioSurf);

        // Encoder spec: HW + (optionally) low-latency rate control.
        std::vector<const void *> spk{kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder};
        std::vector<const void *> spv{kCFBooleanTrue};
        if (low_latency) {
            spk.push_back(kVTVideoEncoderSpecification_EnableLowLatencyRateControl);
            spv.push_back(kCFBooleanTrue);
        }
        CFDictionaryRef spec = make_cf_dict(spk.data(), spv.data(), (CFIndex)spk.size());

        OSStatus st = VTCompressionSessionCreate(nullptr, width, height, kCMVideoCodecType_H264,
                                                 spec, srcAttrs, nullptr, output_cb, &m_sink,
                                                 &m_session);
        CFRelease(spec);
        CFRelease(srcAttrs);
        if (st != noErr || !m_session)
            throw std::runtime_error("VTCompressionSessionCreate failed: " + std::to_string(st));

        VTSessionSetProperty(m_session, kVTCompressionPropertyKey_RealTime,
                             realtime ? kCFBooleanTrue : kCFBooleanFalse);
        VTSessionSetProperty(m_session, kVTCompressionPropertyKey_AllowFrameReordering,
                             kCFBooleanFalse);  // no B-frames: output order == input order
        VTSessionSetProperty(m_session, kVTCompressionPropertyKey_ProfileLevel,
                             kVTProfileLevel_H264_Baseline_AutoLevel);
        if (bitrate > 0) set_session_num(m_session, kVTCompressionPropertyKey_AverageBitRate, bitrate);
        set_session_num(m_session, kVTCompressionPropertyKey_ExpectedFrameRate, m_fps);
        if (gop > 0) set_session_num(m_session, kVTCompressionPropertyKey_MaxKeyFrameInterval, gop);
        // BT.601 limited range (matches gpu.rgb_to_nv12); written into the SPS VUI.
        VTSessionSetProperty(m_session, kVTCompressionPropertyKey_YCbCrMatrix,
                             kCVImageBufferYCbCrMatrix_ITU_R_601_4);
        VTSessionSetProperty(m_session, kVTCompressionPropertyKey_ColorPrimaries,
                             kCVImageBufferColorPrimaries_SMPTE_C);
        VTSessionSetProperty(m_session, kVTCompressionPropertyKey_TransferFunction,
                             kCVImageBufferTransferFunction_ITU_R_709_2);

        VTCompressionSessionPrepareToEncodeFrames(m_session);
        m_pool = VTCompressionSessionGetPixelBufferPool(m_session);  // may be NULL; fallback below
    }

    ~VtEncoder() { close(); }

    py::bytes encode(py::buffer frame, bool force_idr) {
        if (!m_session) throw std::runtime_error("encoder is closed");

        py::buffer_info info = frame.request();
        if (info.itemsize != 1 || info.format != py::format_descriptor<uint8_t>::format())
            throw std::invalid_argument("NV12 frame must be uint8");
        if (info.ndim != 2 || info.shape[0] != m_height + m_height / 2 || info.shape[1] != m_width)
            throw std::invalid_argument("NV12 frame must have shape (H + H//2, W) matching the encoder");
        if (info.strides[1] != 1 || info.strides[0] != m_width)
            throw std::invalid_argument("NV12 frame must be C-contiguous");
        const uint8_t *src = static_cast<const uint8_t *>(info.ptr);

        py::bytes out;
        {
            // Heavy lifting with the GIL released; `info`/`frame` keep the source pinned.
            py::gil_scoped_release rel;

            CVPixelBufferRef pb = nullptr;
            if (m_pool) CVPixelBufferPoolCreatePixelBuffer(nullptr, m_pool, &pb);
            if (!pb) {
                int32_t f = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
                CVPixelBufferCreate(nullptr, m_width, m_height, f, nullptr, &pb);
            }
            if (!pb) throw std::runtime_error("could not obtain a CVPixelBuffer");

            // --- input path: copy host NV12 into the encoder-owned CVPixelBuffer ---
            auto t_copy = std::chrono::steady_clock::now();
            CVPixelBufferLockBaseAddress(pb, 0);
            uint8_t *yDst = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pb, 0);
            size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0);
            for (int y = 0; y < m_height; y++)
                std::memcpy(yDst + (size_t)y * yStride, src + (size_t)y * m_width, m_width);
            uint8_t *uvDst = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pb, 1);
            size_t uvStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1);
            const uint8_t *uvSrc = src + (size_t)m_width * m_height;
            for (int y = 0; y < m_height / 2; y++)
                std::memcpy(uvDst + (size_t)y * uvStride, uvSrc + (size_t)y * m_width, m_width);
            CVPixelBufferUnlockBaseAddress(pb, 0);
            m_last_copy_ms = ms_since(t_copy);

            CFDictionaryRef frameProps = nullptr;
            if (force_idr) {
                const void *k[] = {kVTEncodeFrameOptionKey_ForceKeyFrame};
                const void *v[] = {kCFBooleanTrue};
                frameProps = make_cf_dict(k, v, 1);
            }
            CMTime pts = CMTimeMake(m_frame_num++, m_fps);
            CMTime dur = CMTimeMake(1, m_fps);
            VTEncodeInfoFlags flags = 0;
            auto t_enc = std::chrono::steady_clock::now();
            OSStatus st =
                VTCompressionSessionEncodeFrame(m_session, pb, pts, dur, frameProps, nullptr, &flags);
            if (frameProps) CFRelease(frameProps);
            CVPixelBufferRelease(pb);  // VT retained it internally; release our +1
            if (st != noErr) throw std::runtime_error("EncodeFrame failed: " + std::to_string(st));

            // Synchronous 1-in-1-out: block until this frame's callback has fired.
            VTCompressionSessionCompleteFrames(m_session, kCMTimeInvalid);
            m_last_encode_ms = ms_since(t_enc);
            out = drain_locked();
        }
        return out;
    }

    py::bytes flush() {
        if (!m_session) return py::bytes();
        {
            py::gil_scoped_release rel;
            VTCompressionSessionCompleteFrames(m_session, kCMTimeInvalid);
        }
        std::lock_guard<std::mutex> lk(m_sink.mu);
        py::bytes out((const char *)m_sink.pending.data(), m_sink.pending.size());
        m_sink.pending.clear();
        return out;
    }

    void close() {
        if (m_session) {
            VTCompressionSessionCompleteFrames(m_session, kCMTimeInvalid);
            VTCompressionSessionInvalidate(m_session);
            CFRelease(m_session);
            m_session = nullptr;
        }
    }

    int width() const { return m_width; }
    int height() const { return m_height; }

    // Per-frame timing of the last encode() call (milliseconds), for benchmarking the
    // input path: copy = host NV12 -> CVPixelBuffer memcpy (the cost a zero-copy path
    // would remove); encode = VTCompressionSessionEncodeFrame + CompleteFrames (the
    // synchronous HW encode itself).
    double last_copy_ms() const { return m_last_copy_ms; }
    double last_encode_ms() const { return m_last_encode_ms; }

    // "avc1.PPCCLL" derived from the *actual* emitted SPS (VideoToolbox picks the level
    // from resolution via AutoLevel, so this is NOT a constant). Empty until the first
    // keyframe has been produced.
    std::string codec_string() {
        std::lock_guard<std::mutex> lk(m_sink.mu);
        if (m_sink.sps_profile < 0) return "";
        char buf[16];
        std::snprintf(buf, sizeof(buf), "avc1.%02X%02X%02X", m_sink.sps_profile,
                      m_sink.sps_constraint, m_sink.sps_level);
        return std::string(buf);
    }

private:
    py::bytes drain_locked() {
        // Caller holds the GIL released; we take only the C++ mutex.
        std::lock_guard<std::mutex> lk(m_sink.mu);
        py::gil_scoped_acquire gil;  // building py::bytes needs the GIL
        py::bytes out((const char *)m_sink.pending.data(), m_sink.pending.size());
        m_sink.pending.clear();
        return out;
    }

    int m_width, m_height, m_fps;
    uint64_t m_frame_num = 0;
    double m_last_copy_ms = 0.0, m_last_encode_ms = 0.0;
    VTCompressionSessionRef m_session = nullptr;
    CVPixelBufferPoolRef m_pool = nullptr;  // owned by the session
    Sink m_sink;
};

// Cheap capability probe used by the Python loader / `pdum.rfb`: can VideoToolbox open
// an H.264 session at all on this box? (Always macOS-only since the frameworks link.)
static bool vt_supported() {
    VTCompressionSessionRef s = nullptr;
    const void *k[] = {kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder};
    const void *v[] = {kCFBooleanTrue};
    CFDictionaryRef spec = make_cf_dict(k, v, 1);
    OSStatus st = VTCompressionSessionCreate(nullptr, 64, 64, kCMVideoCodecType_H264, spec, nullptr,
                                             nullptr, nullptr, nullptr, &s);
    CFRelease(spec);
    if (s) {
        VTCompressionSessionInvalidate(s);
        CFRelease(s);
    }
    return st == noErr;
}

PYBIND11_MODULE(_vtenc, m) {
    m.doc() = "pdum.vtenc — host NV12 -> H.264 Annex B via Apple VideoToolbox";
    m.def("supported", &vt_supported,
          "True if VideoToolbox can open an H.264 compression session on this machine.");
    py::class_<VtEncoder>(m, "VtEncoder")
        .def(py::init<int, int, std::string, int, int, int, bool, bool>(), py::arg("width"),
             py::arg("height"), py::arg("codec") = "h264", py::arg("fps") = 30, py::arg("gop") = 30,
             py::arg("bitrate") = 12000000, py::arg("realtime") = true, py::arg("low_latency") = true,
             "Create an NV12 -> H.264 Annex B VideoToolbox encoder (fixed resolution, even "
             "dimensions). Low-latency, no frame reordering, in-band SPS/PPS on every IDR.")
        .def("encode", &VtEncoder::encode, py::arg("frame"), py::arg("force_idr") = false,
             "Encode one host-visible NV12 frame (buffer-protocol object of shape (H*3//2, W) "
             "uint8, contiguous). Returns this frame's H.264 Annex B access unit (bytes).")
        .def("flush", &VtEncoder::flush, "Drain any buffered output; returns Annex B bytes.")
        .def("close", &VtEncoder::close)
        .def_property_readonly("width", &VtEncoder::width)
        .def_property_readonly("height", &VtEncoder::height)
        .def_property_readonly("codec_string", &VtEncoder::codec_string,
                               "avc1.PPCCLL derived from the emitted SPS (empty until first keyframe).")
        .def_property_readonly("last_copy_ms", &VtEncoder::last_copy_ms,
                               "Milliseconds spent copying host NV12 into the CVPixelBuffer in the "
                               "last encode() (the cost a zero-copy input path would remove).")
        .def_property_readonly("last_encode_ms", &VtEncoder::last_encode_ms,
                               "Milliseconds spent in VTCompressionSessionEncodeFrame + CompleteFrames "
                               "in the last encode() (the synchronous HW encode itself).");
}
