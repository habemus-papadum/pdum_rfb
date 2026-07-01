// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Nehal Patel / pdum.rfb contributors.
//
// nvenc_ext.cpp — `pdum.nvenc._nvenc`: a thin pybind11 binding over NVIDIA's
// NvEncoderCuda SDK helper (vendored verbatim under ../third_party, unmodified —
// see PROVENANCE.md). This is the *only* hand-written C++ in the package.
//
// It encodes a GPU-resident NV12 frame (from any __cuda_array_interface__ producer
// — CuPy / PyTorch / Numba) into H.264/HEVC Annex B with no host copy, and needs no
// PyAV. Built against a current pybind11 (upstream PyNvVideoCodec pins 2.10.0, which
// can't build on Python 3.14). One CMake target per NVENC ABI (12.1 / 13.0); the
// Python loader (pdum/nvenc/__init__.py) picks the one the driver supports.
//
// Fixed-resolution NV12 in, Annex B bytes out, one NvEncoderCuda per instance.
//
// Input path: NvEncoder::GetNextInputFrame() returns an NVENC-owned device surface;
// NvEncoderCuda::CopyToDeviceFrame does an on-GPU (device->device) NV12 copy into it.
// That single intra-GPU copy is negligible vs the host round-trip the CPU path pays;
// true zero-copy (NvEncoder::RegisterResource) is a follow-up. See
// docs/nvenc_sdk_evaluation.md.

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <dlfcn.h>

#include <cstdint>
#include <cstring>
#include <deque>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

#include <cuda.h>

#include "NvEncoder/NvEncoderCuda.h"

// ---- NVTX: our own binding-boundary ranges -------------------------------
// USE_NVTX also activates NVIDIA's internal ranges (EncodeFrame/DoEncode/
// MapResources/CopyToDeviceFrame) via NvCodecUtils.h, so a profiling build shows
// the full nest: pdum.encode > {read_cai, copy_to_nvenc > CopyToDeviceFrame_*,
// submit > EncodeFrame > DoEncode, collect_output}.
#ifdef USE_NVTX
#include <nvtx3/nvtx3.hpp>
#define PDUM_NVTX_CAT2(a, b) a##b
#define PDUM_NVTX_CAT(a, b) PDUM_NVTX_CAT2(a, b)
#define PDUM_NVTX_RANGE(name) nvtx3::scoped_range PDUM_NVTX_CAT(_pdum_nvtx_, __LINE__) { name }
#else
#define PDUM_NVTX_RANGE(name) \
    do {                      \
    } while (0)
#endif

namespace py = pybind11;

static void cuCheck(CUresult r, const char *what) {
    if (r != CUDA_SUCCESS) {
        const char *name = nullptr;
        cuGetErrorName(r, &name);
        throw std::runtime_error(std::string(what) + " failed: " + (name ? name : "unknown"));
    }
}

static GUID pick_preset(const std::string &p) {
    if (p == "p1") return NV_ENC_PRESET_P1_GUID;
    if (p == "p2") return NV_ENC_PRESET_P2_GUID;
    if (p == "p3") return NV_ENC_PRESET_P3_GUID;
    if (p == "p4") return NV_ENC_PRESET_P4_GUID;
    if (p == "p5") return NV_ENC_PRESET_P5_GUID;
    if (p == "p6") return NV_ENC_PRESET_P6_GUID;
    if (p == "p7") return NV_ENC_PRESET_P7_GUID;
    throw std::invalid_argument("unknown preset (want p1..p7): " + p);
}

static NV_ENC_TUNING_INFO pick_tuning(const std::string &t) {
    if (t == "ull" || t == "ultra_low_latency") return NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    if (t == "ll" || t == "low_latency") return NV_ENC_TUNING_INFO_LOW_LATENCY;
    if (t == "hq" || t == "high_quality") return NV_ENC_TUNING_INFO_HIGH_QUALITY;
    throw std::invalid_argument("unknown tuning (want ll/ull/hq): " + t);
}

// Does the host driver support the NVENC API version this module was built against?
// A cheap probe (dlopen + NvEncodeAPIGetMaxSupportedVersion; no encode session) the
// Python loader uses to pick between the 12.1 and 13.0 ABI builds. Mirrors the check
// NvEncoder::LoadNvEncApi makes before it would otherwise hard-fail.
static bool nvenc_supported() {
    void *h = dlopen("libnvidia-encode.so.1", RTLD_LAZY);
    if (!h) return false;
    using GetMaxVer = int (*)(uint32_t *);
    auto get_max = reinterpret_cast<GetMaxVer>(dlsym(h, "NvEncodeAPIGetMaxSupportedVersion"));
    bool ok = false;
    if (get_max) {
        uint32_t driver_max = 0;
        if (get_max(&driver_max) == 0) {
            const uint32_t want = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
            ok = want <= driver_max;
        }
    }
    dlclose(h);
    return ok;
}

class NvencEncoder {
public:
    NvencEncoder(int width, int height, const std::string &codec, const std::string &preset,
               const std::string &tuning, int fps, int gop, int bitrate, int gpu_id, size_t cuda_context,
               int extra_output_delay, const std::string &profile)
        : m_width(width), m_height(height) {
        if (width <= 0 || height <= 0 || (width & 1) || (height & 1))
            throw std::invalid_argument("width/height must be positive and even");

        cuCheck(cuInit(0), "cuInit");
        if (cuda_context) {
            // Share an existing context (e.g. CuPy/PyTorch primary context).
            m_ctx = reinterpret_cast<CUcontext>(cuda_context);
            m_own_ctx = false;
        } else {
            cuCheck(cuDeviceGet(&m_dev, gpu_id), "cuDeviceGet");
            cuCheck(cuDevicePrimaryCtxRetain(&m_ctx, m_dev), "cuDevicePrimaryCtxRetain");
            m_own_ctx = true;
        }

        const bool is_hevc = (codec == "hevc" || codec == "h265");
        GUID codec_guid = is_hevc ? NV_ENC_CODEC_HEVC_GUID : NV_ENC_CODEC_H264_GUID;

        // nExtraOutputDelay drives NvEncoder's output pipeline depth (output delay =
        // frameIntervalP + lookahead + extra - 1). 0 => zero-latency, synchronous
        // 1-in-1-out (each encode() returns its own frame's access unit) — what a
        // low-latency stream wants. Raise it (NVIDIA's default is 3) to overlap encode
        // with rendering for throughput, at the cost of that many frames of latency.
        m_enc = new NvEncoderCuda(m_ctx, /*cuStream=*/nullptr, (uint32_t)width, (uint32_t)height,
                                  NV_ENC_BUFFER_FORMAT_NV12,
                                  (uint32_t)(extra_output_delay < 0 ? 0 : extra_output_delay));

        NV_ENC_INITIALIZE_PARAMS init = {NV_ENC_INITIALIZE_PARAMS_VER};
        NV_ENC_CONFIG cfg = {NV_ENC_CONFIG_VER};
        init.encodeConfig = &cfg;
        m_enc->CreateDefaultEncoderParams(&init, codec_guid, pick_preset(preset), pick_tuning(tuning));

        if (fps > 0) {
            init.frameRateNum = (uint32_t)fps;
            init.frameRateDen = 1;
        }
        // pdum.rfb invariant: no B-frames (output order == input order).
        cfg.frameIntervalP = 1;

        // Zero reordering delay. Tell decoders there is *no* frame reordering
        // (num_reorder_frames=0) so they emit each frame immediately. Without this, NVENC
        // leaves the SPS VUI bitstream_restriction absent, so a browser's *hardware* H.264
        // decoder must assume worst-case reordering and buffers up to the level's DPB size
        // (~5 frames at 720p / L3.1) before its first output. Under the session's small
        // max_inflight that starves — the decoder never gets enough frames to emit, so the
        // canvas silently freezes with no error. libx264's zerolatency sets exactly this
        // (bitstream_restriction_flag=1, max_num_reorder_frames=0), which is why the CPU
        // path works live and NVENC did not. Both are needed: zeroReorderDelay sets the
        // value, bitstreamRestrictionFlag makes it (and max_dec_frame_buffering) land in
        // the SPS so the decoder actually reads it.
        cfg.rcParams.zeroReorderDelay = 1;

        if (gop > 0) cfg.gopLength = (uint32_t)gop;

        // Target a bitrate (VBR) so benchmarks are comparable to the PyAV paths;
        // bitrate<=0 leaves the preset's default rate control untouched.
        if (bitrate > 0) {
            cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
            cfg.rcParams.averageBitRate = (uint32_t)bitrate;
            cfg.rcParams.maxBitRate = (uint32_t)bitrate;
            cfg.rcParams.vbvBufferSize = (uint32_t)(bitrate / (fps > 0 ? fps : 30));
            cfg.rcParams.vbvInitialDelay = cfg.rcParams.vbvBufferSize;
        }

        // Browser WebCodecs wants in-band SPS/PPS (VPS) repeated on every IDR.
        if (is_hevc) {
            cfg.encodeCodecConfig.hevcConfig.repeatSPSPPS = 1;
            cfg.encodeCodecConfig.hevcConfig.hevcVUIParameters.bitstreamRestrictionFlag = 1;
            if (gop > 0) cfg.encodeCodecConfig.hevcConfig.idrPeriod = (uint32_t)gop;
        } else {
            cfg.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
            cfg.encodeCodecConfig.h264Config.h264VUIParameters.bitstreamRestrictionFlag = 1;
            if (gop > 0) cfg.encodeCodecConfig.h264Config.idrPeriod = (uint32_t)gop;
        }

        // H.264 profile. Default "auto" keeps NVENC's choice (High). Callers that target
        // browser WebCodecs should request "baseline": hardware H.264 decoders are stricter
        // than software ones and can silently fail on High profile, so Baseline (profile_idc
        // 66) is the compatible choice — matching the libx264 / PyAV-NVENC backends.
        if (!is_hevc && !profile.empty() && profile != "auto") {
            if (profile == "baseline")
                cfg.profileGUID = NV_ENC_H264_PROFILE_BASELINE_GUID;
            else if (profile == "main")
                cfg.profileGUID = NV_ENC_H264_PROFILE_MAIN_GUID;
            else if (profile == "high")
                cfg.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
            else
                throw std::invalid_argument("unknown h264 profile (want auto/baseline/main/high): " + profile);
        }

        m_enc->CreateEncoder(&init);
    }

    ~NvencEncoder() { close(); }

    // Synchronous 1-in-1-out: encode one GPU NV12 frame and return its Annex B blob
    // (may be empty while NVENC fills its pipeline at extra_output_delay>0). The
    // low-latency default; seq attribution is by call ordering above this seam.
    py::bytes encode(py::object frame, bool force_idr) {
        PDUM_NVTX_RANGE("pdum.encode");
        if (!m_enc) throw std::runtime_error("encoder is closed");
        copy_input(frame);

        std::vector<NvEncOutputFrame> out;
        {
            PDUM_NVTX_RANGE("pdum.submit");
            NV_ENC_PIC_PARAMS pic = {NV_ENC_PIC_PARAMS_VER};
            if (force_idr) pic.encodePicFlags |= NV_ENC_PIC_FLAG_FORCEIDR;
            py::gil_scoped_release rel;
            m_enc->EncodeFrame(out, &pic);
        }
        return collect(out);
    }

    // Pipelined: submit one GPU NV12 frame tagged with `seq` WITHOUT assuming
    // 1-in-1-out, and return the access units ready *now* as (recovered_seq, annexb,
    // keyframe) tuples (0..N; output order == input order, no B-frames). Lets NVENC
    // keep several frames in flight (throughput) while the caller recovers seq
    // attribution from the tag instead of call ordering. Pair with flush_pipeline().
    //
    // NOTE on the token channel: the guide's plan was to carry `seq` on
    // NV_ENC_PIC_PARAMS.inputTimeStamp and read it back on NvEncOutputFrame.timeStamp.
    // The *vendored* NvEncoder helper defeats that: NvEncoder::DoEncode overwrites
    // inputTimeStamp with its own counter (NvEncoder_130.cpp:690 / _121.cpp:653), and
    // third_party/ is verbatim/read-only. So `timeStamp` echoes NVENC's internal
    // submit index, not our seq. We instead recover seq from an in-order FIFO of the
    // tags we pushed — valid because frameIntervalP=1 guarantees output order ==
    // input order (the same invariant the browser-side displayed FIFO already relies on).
    std::vector<std::tuple<int64_t, py::bytes, bool>> submit(py::object frame, int64_t seq,
                                                             bool force_idr) {
        PDUM_NVTX_RANGE("pdum.submit_pipelined");
        if (!m_enc) throw std::runtime_error("encoder is closed");
        copy_input(frame);
        m_pending_seqs.push_back(seq);  // recovered on the way out (in submission order)

        std::vector<NvEncOutputFrame> out;
        {
            NV_ENC_PIC_PARAMS pic = {NV_ENC_PIC_PARAMS_VER};
            if (force_idr) pic.encodePicFlags |= NV_ENC_PIC_FLAG_FORCEIDR;
            py::gil_scoped_release rel;
            m_enc->EncodeFrame(out, &pic);  // 0..N ready frames
        }
        return tag(out);
    }

    // Synchronous flush: drain any buffered output as one concatenated Annex B blob.
    py::bytes flush() {
        if (!m_enc) return py::bytes();
        std::vector<NvEncOutputFrame> out;
        {
            py::gil_scoped_release rel;
            m_enc->EndEncode(out);
        }
        return collect(out);
    }

    // Pipelined flush: complete the in-flight tail; returns the remaining seq-tagged
    // AUs (call once at end-of-stream to recover the last `extra_output_delay` frames).
    std::vector<std::tuple<int64_t, py::bytes, bool>> flush_pipeline() {
        if (!m_enc) return {};
        std::vector<NvEncOutputFrame> out;
        {
            py::gil_scoped_release rel;
            m_enc->EndEncode(out);
        }
        return tag(out);
    }

    void close() {
        if (m_enc) {
            try {
                std::vector<NvEncOutputFrame> out;
                m_enc->EndEncode(out);
            } catch (...) {
            }
            m_enc->DestroyEncoder();
            delete m_enc;
            m_enc = nullptr;
        }
        if (m_own_ctx && m_ctx) {
            cuDevicePrimaryCtxRelease(m_dev);
            m_ctx = nullptr;
        }
    }

    int width() const { return m_width; }
    int height() const { return m_height; }

private:
    // Read an NV12 frame and copy it into NVENC's next input surface. Accepts either a
    // GPU-resident tensor (`__cuda_array_interface__`, e.g. CuPy — the zero-copy path) or a
    // host array (`__array_interface__`, e.g. numpy — a pageable-copy convenience). The
    // vendored NvEncoderCuda::CopyToDeviceFrame handles both source memory types. GIL must
    // be held (Python attr access); shared by encode() and submit(). The copy completes
    // before this returns, so a reused staging buffer upstream is free to overwrite after.
    void copy_input(py::object frame) {
        uintptr_t src_ptr = 0;
        uint32_t src_pitch = (uint32_t)m_width;  // NV12 luma stride == width when contiguous
        CUmemorytype src_mem = CU_MEMORYTYPE_DEVICE;
        {
            PDUM_NVTX_RANGE("pdum.read_iface");
            py::dict iface;
            if (py::hasattr(frame, "__cuda_array_interface__")) {
                iface = frame.attr("__cuda_array_interface__").cast<py::dict>();
                src_mem = CU_MEMORYTYPE_DEVICE;
            } else if (py::hasattr(frame, "__array_interface__")) {
                iface = frame.attr("__array_interface__").cast<py::dict>();  // host (numpy)
                src_mem = CU_MEMORYTYPE_HOST;
            } else {
                throw std::runtime_error(
                    "frame exposes neither __cuda_array_interface__ (GPU) nor __array_interface__ (host)");
            }
            py::tuple data = iface["data"].cast<py::tuple>();
            src_ptr = data[0].cast<uintptr_t>();
            if (iface.contains("strides") && !iface["strides"].is_none()) {
                py::tuple strides = iface["strides"].cast<py::tuple>();
                src_pitch = (uint32_t)strides[0].cast<int64_t>();
            }
        }
        const NvEncInputFrame *in = m_enc->GetNextInputFrame();
        PDUM_NVTX_RANGE("pdum.copy_to_nvenc");
        NvEncoderCuda::CopyToDeviceFrame(m_ctx, (void *)src_ptr, src_pitch,
                                         (CUdeviceptr)in->inputPtr, in->pitch, m_width, m_height,
                                         src_mem, in->bufferFormat, in->chromaOffsets,
                                         in->numChromaPlanes);
    }

    py::bytes collect(std::vector<NvEncOutputFrame> &out) {
        PDUM_NVTX_RANGE("pdum.collect_output");
        size_t total = 0;
        for (auto &o : out) total += o.frame.size();
        std::string buf;
        buf.reserve(total);
        for (auto &o : out)
            if (!o.frame.empty()) buf.append((const char *)o.frame.data(), o.frame.size());
        return py::bytes(buf);
    }

    // Build list[(recovered_seq, annexb_bytes, keyframe)] from ready output frames,
    // popping the pending-seq FIFO in order. keyframe comes from pictureType (exact,
    // unlike the byte-scan _contains_idr the sync path uses). GIL must be held (py::bytes).
    std::vector<std::tuple<int64_t, py::bytes, bool>> tag(std::vector<NvEncOutputFrame> &out) {
        std::vector<std::tuple<int64_t, py::bytes, bool>> r;
        r.reserve(out.size());
        for (auto &o : out) {
            int64_t seq = -1;
            if (!m_pending_seqs.empty()) {
                seq = m_pending_seqs.front();
                m_pending_seqs.pop_front();
            }
            bool key = (o.pictureType == NV_ENC_PIC_TYPE_IDR || o.pictureType == NV_ENC_PIC_TYPE_I);
            r.emplace_back(seq, py::bytes((const char *)o.frame.data(), o.frame.size()), key);
        }
        return r;
    }

    int m_width, m_height;
    std::deque<int64_t> m_pending_seqs;  // pipelined: submitted tags awaiting output (in order)
    CUcontext m_ctx = nullptr;
    CUdevice m_dev = 0;
    bool m_own_ctx = false;
    NvEncoderCuda *m_enc = nullptr;
};

PYBIND11_MODULE(_nvenc, m) {
    m.doc() = "pdum.nvenc — GPU NV12 -> H.264/HEVC Annex B via NVIDIA NvEncoderCuda";
#ifdef USE_NVTX
    m.attr("nvtx_enabled") = true;
#else
    m.attr("nvtx_enabled") = false;
#endif
    m.attr("nvenc_api_version") = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
    m.def("supported", &nvenc_supported,
          "True if the host NVIDIA driver supports this build's NVENC API version "
          "(used by the loader to pick the 12.1 vs 13.0 ABI).");
    py::class_<NvencEncoder>(m, "NvencEncoder")
        .def(py::init<int, int, std::string, std::string, std::string, int, int, int, int, size_t, int, std::string>(),
             py::arg("width"), py::arg("height"), py::arg("codec") = "h264", py::arg("preset") = "p3",
             py::arg("tuning") = "ll", py::arg("fps") = 30, py::arg("gop") = 30, py::arg("bitrate") = 0,
             py::arg("gpu_id") = 0, py::arg("cuda_context") = 0, py::arg("extra_output_delay") = 0,
             py::arg("profile") = "auto",
             "Create an NV12->H.264/HEVC Annex B encoder. Pass cuda_context=0 to retain "
             "the device primary context (shared with CuPy/PyTorch). extra_output_delay=0 "
             "(default) is zero-latency (each encode() returns its own frame); raise it "
             "to overlap encode with rendering for throughput, at a latency cost. profile "
             "(H.264): 'auto' (NVENC default, High) | 'baseline' | 'main' | 'high' — use "
             "'baseline' for maximum browser/hardware-decoder compatibility.")
        .def("encode", &NvencEncoder::encode, py::arg("frame"), py::arg("force_idr") = false,
             "Encode one NV12 frame of shape (H*3//2, W) uint8 -- either a GPU tensor "
             "(__cuda_array_interface__, zero-copy) or a host array (__array_interface__, e.g. "
             "numpy; a pageable device copy). Returns Annex B bytes (may be empty while NVENC "
             "fills its pipeline). Synchronous seq-by-call-order; pair with flush().")
        .def("submit", &NvencEncoder::submit, py::arg("frame"), py::arg("seq"),
             py::arg("force_idr") = false,
             "Pipelined: submit one NV12 frame (GPU or host, as encode()) tagged with `seq` WITHOUT assuming "
             "1-in-1-out, returning the access units ready now as (seq, annexb_bytes, keyframe) "
             "tuples (0..N; output order == input order). Each seq is the recovered tag of the "
             "frame it actually encodes, regardless of extra_output_delay. Pair with flush_pipeline().")
        .def("flush", &NvencEncoder::flush, "Flush the encoder; returns any remaining Annex B bytes.")
        .def("flush_pipeline", &NvencEncoder::flush_pipeline,
             "Complete the in-flight tail and return the remaining (seq, annexb_bytes, keyframe) "
             "tuples; the pipelined counterpart of flush().")
        .def("close", &NvencEncoder::close)
        .def_property_readonly("width", &NvencEncoder::width)
        .def_property_readonly("height", &NvencEncoder::height);
}
