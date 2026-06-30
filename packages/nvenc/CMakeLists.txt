# SPDX-License-Identifier: MIT
# Builds pdum.nvenc's NVENC extension against NVIDIA's Video Codec SDK encoder
# (vendored verbatim under third_party/). Two ABI variants are built from the same
# source — NVENC SDK 12.1 and 13.0 — and pdum/nvenc/__init__.py loads whichever the
# host driver supports. pybind11 is a current release (upstream PyNvVideoCodec pins
# 2.10.0, which can't build on Python 3.14); the NVIDIA sources are unmodified.
cmake_minimum_required(VERSION 3.21)
project(pdum_nvenc LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(USE_NVTX "Enable NVTX profiling ranges (header-only; ~0 cost when no profiler attached)" ON)

include(FetchContent)
set(PYBIND11_FINDPYTHON ON)
FetchContent_Declare(pybind11
  GIT_REPOSITORY https://github.com/pybind/pybind11.git
  GIT_TAG v3.0.4
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(pybind11)

# Encode is driver-API only; libnvidia-encode is dlopen'd at runtime, not linked.
find_path(CUDA_INCLUDE_DIR cuda.h
  PATHS ${CUDAToolkit_ROOT} /usr/local/cuda/include /usr/include REQUIRED)
find_library(CUDA_DRIVER_LIB cuda
  PATHS /usr/local/cuda/lib64/stubs /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu REQUIRED)
find_package(Threads REQUIRED)

if(USE_NVTX)
  FetchContent_Declare(nvtx
    GIT_REPOSITORY https://github.com/NVIDIA/NVTX.git
    GIT_TAG v3.1.0
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR c)
  FetchContent_MakeAvailable(nvtx)
endif()

set(NV third_party)
# Both NvEncoder_121.cpp and NvEncoder_130.cpp are guarded by their NVENC_VER_* define,
# so each ABI build compiles only the matching one (the other is an empty TU).
set(NV_SOURCES
  src/cpp/nvenc_ext.cpp
  ${NV}/NvEncoder/NvEncoderCuda.cpp
  ${NV}/NvEncoder/NvEncoder_121.cpp
  ${NV}/NvEncoder/NvEncoder_130.cpp)

# Each variant compiles PYBIND11_MODULE(_nvenc) -> the same PyInit__nvenc symbol, but
# lands in a distinct file (_nvenc_121 / _nvenc_130); the loader imports the chosen
# file explicitly by path.
function(add_nvenc_abi target outname define)
  pybind11_add_module(${target} MODULE ${NV_SOURCES})
  target_compile_definitions(${target} PRIVATE ${define})
  target_include_directories(${target} PRIVATE
    ${NV} ${NV}/NvEncoder ${NV}/Utils ${NV}/Interface ${CUDA_INCLUDE_DIR})
  target_link_libraries(${target} PRIVATE ${CUDA_DRIVER_LIB} Threads::Threads ${CMAKE_DL_LIBS})
  if(USE_NVTX)
    target_link_libraries(${target} PRIVATE nvtx3-cpp)
    target_compile_definitions(${target} PRIVATE USE_NVTX=1)
  endif()
  target_compile_options(${target} PRIVATE -w)   # don't own the vendored SDK's warnings
  set_target_properties(${target} PROPERTIES OUTPUT_NAME ${outname})
  install(TARGETS ${target} LIBRARY DESTINATION pdum/nvenc)
endfunction()

add_nvenc_abi(nvenc_121 _nvenc_121 NVENC_VER_12_1)   # NVENC SDK 12.1 ABI (older drivers)
add_nvenc_abi(nvenc_130 _nvenc_130 NVENC_VER_13_0)   # NVENC SDK 13.0 ABI (newer drivers)
