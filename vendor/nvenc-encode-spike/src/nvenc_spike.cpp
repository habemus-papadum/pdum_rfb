// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Nehal Patel / pdum.rfb contributors.
//
// nvenc_spike.cpp — a thin pybind11 binding over NVIDIA's NvEncoderCuda SDK
// helper (vendored verbatim under ../third_party). This is the *only* hand-written
// C++ in the spike; the NVIDIA files are unmodified. It exists to answer two
// questions cheaply:
//
//   1. Does NVIDIA's Video Codec SDK encoder C++ build + run on CPython 3.14
//      with a current pybind11 (the original PyNvVideoCodec pins pybind11 2.10.0,
//      which does not)?
//   2. Can we encode a GPU-resident NV12 frame (from any __cuda_array_interface__
//      producer: CuPy / PyTorch / Numba) into H.264 Annex B with no host copy,
//      and see the encode stages in Nsight Systems?
//
// It is deliberately minimal: fixed-resolution NV12 in, H.264/HEVC Annex B bytes
// out, one NvEncoderCuda per instance. The full integration (fitting pdum.rfb's
// EncoderBackend protocol, reconfigure, SEI, etc.) is out of scope — see
// docs/nvenc_sdk_evaluation.md.
//
// Input path: NvEncoder::GetNextInputFrame() returns an NVENC-owned device
// surface; NvEncoderCuda::CopyToDeviceFrame does an on-GPU (device->device) NV12
// copy into it. That single intra-GPU copy is negligible vs the host round-trip
// the CPU path pays; true zero-copy (NvEncoder::RegisterResource) is a follow-up.

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
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

class NvencSpike {
public:
    NvencSpike(int width, int height, const std::string &codec, const std::string &preset,
               const std::string &tuning, int fps, int gop, int gpu_id, size_t cuda_context)
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

        m_enc = new NvEncoderCuda(m_ctx, /*cuStream=*/nullptr, (uint32_t)width, (uint32_t)height,
                                  NV_ENC_BUFFER_FORMAT_NV12);

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
        if (gop > 0) cfg.gopLength = (uint32_t)gop;

        // Browser WebCodecs wants in-band SPS/PPS (VPS) repeated on every IDR.
        if (is_hevc) {
            cfg.encodeCodecConfig.hevcConfig.repeatSPSPPS = 1;
            if (gop > 0) cfg.encodeCodecConfig.hevcConfig.idrPeriod = (uint32_t)gop;
        } else {
            cfg.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
            if (gop > 0) cfg.encodeCodecConfig.h264Config.idrPeriod = (uint32_t)gop;
        }

        m_enc->CreateEncoder(&init);
    }

    ~NvencSpike() { close(); }

    py::bytes encode(py::object frame, bool force_idr) {
        PDUM_NVTX_RANGE("pdum.encode");
        if (!m_enc) throw std::runtime_error("encoder is closed");

        CUdeviceptr src_ptr = 0;
        uint32_t src_pitch = (uint32_t)m_width;  // NV12 luma stride == width when contiguous
        {
            PDUM_NVTX_RANGE("pdum.read_cai");
            py::dict cai = frame.attr("__cuda_array_interface__").cast<py::dict>();
            py::tuple data = cai["data"].cast<py::tuple>();
            src_ptr = (CUdeviceptr)data[0].cast<uintptr_t>();
            if (cai.contains("strides") && !cai["strides"].is_none()) {
                py::tuple strides = cai["strides"].cast<py::tuple>();
                src_pitch = (uint32_t)strides[0].cast<int64_t>();
            }
        }

        const NvEncInputFrame *in = m_enc->GetNextInputFrame();
        {
            PDUM_NVTX_RANGE("pdum.copy_to_nvenc");
            NvEncoderCuda::CopyToDeviceFrame(m_ctx, (void *)src_ptr, src_pitch,
                                             (CUdeviceptr)in->inputPtr, in->pitch, m_width, m_height,
                                             CU_MEMORYTYPE_DEVICE, in->bufferFormat, in->chromaOffsets,
                                             in->numChromaPlanes);
        }

        std::vector<NvEncOutputFrame> out;
        {
            PDUM_NVTX_RANGE("pdum.submit");
            NV_ENC_PIC_PARAMS pic = {NV_ENC_PIC_PARAMS_VER};
            pic.inputTimeStamp = m_frame_num++;
            if (force_idr) pic.encodePicFlags |= NV_ENC_PIC_FLAG_FORCEIDR;
            py::gil_scoped_release rel;
            m_enc->EncodeFrame(out, &pic);
        }
        return collect(out);
    }

    py::bytes flush() {
        if (!m_enc) return py::bytes();
        std::vector<NvEncOutputFrame> out;
        {
            py::gil_scoped_release rel;
            m_enc->EndEncode(out);
        }
        return collect(out);
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

    int m_width, m_height;
    uint64_t m_frame_num = 0;
    CUcontext m_ctx = nullptr;
    CUdevice m_dev = 0;
    bool m_own_ctx = false;
    NvEncoderCuda *m_enc = nullptr;
};

PYBIND11_MODULE(_nvenc_spike, m) {
    m.doc() = "pdum.rfb encode-only NVENC spike (thin binding over NVIDIA NvEncoderCuda)";
#ifdef USE_NVTX
    m.attr("nvtx_enabled") = true;
#else
    m.attr("nvtx_enabled") = false;
#endif
    py::class_<NvencSpike>(m, "NvencSpike")
        .def(py::init<int, int, std::string, std::string, std::string, int, int, int, size_t>(),
             py::arg("width"), py::arg("height"), py::arg("codec") = "h264", py::arg("preset") = "p3",
             py::arg("tuning") = "ll", py::arg("fps") = 30, py::arg("gop") = 30, py::arg("gpu_id") = 0,
             py::arg("cuda_context") = 0,
             "Create an NV12->H.264/HEVC Annex B encoder. Pass cuda_context=0 to retain "
             "the device primary context (shared with CuPy/PyTorch).")
        .def("encode", &NvencSpike::encode, py::arg("frame"), py::arg("force_idr") = false,
             "Encode one GPU-resident NV12 frame (any __cuda_array_interface__ tensor of "
             "shape (H*3//2, W) uint8). Returns Annex B bytes (may be empty while NVENC fills "
             "its pipeline).")
        .def("flush", &NvencSpike::flush, "Flush the encoder; returns any remaining Annex B bytes.")
        .def("close", &NvencSpike::close)
        .def_property_readonly("width", &NvencSpike::width)
        .def_property_readonly("height", &NvencSpike::height);
}
