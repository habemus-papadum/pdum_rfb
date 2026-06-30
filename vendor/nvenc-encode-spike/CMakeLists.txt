# SPDX-License-Identifier: MIT
# Encode-only PyNvVideoCodec spike — builds the NVIDIA Video Codec SDK encoder
# (vendored verbatim under third_party/) into a pybind11 module on Python 3.14.
#
# Key difference from upstream PyNvVideoCodec: pybind11 is bumped from the pinned
# 2.10.0 (no 3.14 support) to a current release. Everything else NVIDIA is
# unmodified; all of *our* code is in src/.
cmake_minimum_required(VERSION 3.21)
project(nvenc_encode_spike LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(USE_NVTX "Enable NVTX profiling ranges (header-only; ~0 cost when no profiler attached)" OFF)

# --- pybind11 (THE 3.14 fix: upstream pins 2.10.0, which can't build on 3.14) ---
include(FetchContent)
set(PYBIND11_FINDPYTHON ON)
FetchContent_Declare(pybind11
  GIT_REPOSITORY https://github.com/pybind/pybind11.git
  GIT_TAG v3.0.4
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(pybind11)

# --- CUDA driver (encode is driver-API only; libnvidia-encode is dlopen'd) ------
find_path(CUDA_INCLUDE_DIR cuda.h
  PATHS ${CUDAToolkit_ROOT} /usr/local/cuda/include /usr/include REQUIRED)
find_library(CUDA_DRIVER_LIB cuda
  PATHS /usr/local/cuda/lib64/stubs /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu REQUIRED)
find_package(Threads REQUIRED)

# --- NVTX (optional, header-only; also lights up NVIDIA's internal ranges) ------
if(USE_NVTX)
  FetchContent_Declare(nvtx
    GIT_REPOSITORY https://github.com/NVIDIA/NVTX.git
    GIT_TAG v3.1.0
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR c)
  FetchContent_MakeAvailable(nvtx)
endif()

set(NV third_party)
pybind11_add_module(_nvenc_spike
  src/nvenc_spike.cpp
  ${NV}/NvEncoder/NvEncoderCuda.cpp
  ${NV}/NvEncoder/NvEncoder_121.cpp)   # NVENC SDK 12.1 ABI (default; widely compatible)

target_compile_definitions(_nvenc_spike PRIVATE NVENC_VER_12_1)
target_include_directories(_nvenc_spike PRIVATE
  ${NV} ${NV}/NvEncoder ${NV}/Utils ${NV}/Interface ${CUDA_INCLUDE_DIR})
target_link_libraries(_nvenc_spike PRIVATE ${CUDA_DRIVER_LIB} Threads::Threads ${CMAKE_DL_LIBS})

if(USE_NVTX)
  target_link_libraries(_nvenc_spike PRIVATE nvtx3-cpp)
  target_compile_definitions(_nvenc_spike PRIVATE USE_NVTX=1)
endif()

# Quiet the vendored SDK (we don't own its warnings; do NOT warn-as-error).
target_compile_options(_nvenc_spike PRIVATE -w)

# Wheel layout: the extension lands inside the `nvenc_spike` import package.
install(TARGETS _nvenc_spike LIBRARY DESTINATION nvenc_spike)
