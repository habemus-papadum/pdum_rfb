# SPDX-License-Identifier: MIT
# Builds pdum.vtenc's VideoToolbox extension. Unlike packages/nvenc/ there is no
# vendored SDK: VideoToolbox/CoreVideo/CoreMedia are macOS system frameworks. One
# Objective-C++ source, one extension (`_vtenc`); the system frameworks are a stable
# ABI so there is no multi-ABI dance. pybind11 is a current release (3.0.4) for
# Python 3.14.
cmake_minimum_required(VERSION 3.21)
project(pdum_vtenc LANGUAGES CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
# EnableLowLatencyRateControl is macOS 11.3+; 12.0 keeps the symbol non-weak.
if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0")
endif()

include(FetchContent)
set(PYBIND11_FINDPYTHON ON)
FetchContent_Declare(pybind11
  GIT_REPOSITORY https://github.com/pybind/pybind11.git
  GIT_TAG v3.0.4
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(pybind11)

# The binding is a .mm (Objective-C++) so it can call the VideoToolbox/CoreMedia C APIs.
pybind11_add_module(_vtenc MODULE src/cpp/vtenc_ext.mm)
set_source_files_properties(src/cpp/vtenc_ext.mm PROPERTIES LANGUAGE OBJCXX)

find_library(VIDEOTOOLBOX_LIB VideoToolbox REQUIRED)
find_library(COREVIDEO_LIB CoreVideo REQUIRED)
find_library(COREMEDIA_LIB CoreMedia REQUIRED)
find_library(COREFOUNDATION_LIB CoreFoundation REQUIRED)
find_library(FOUNDATION_LIB Foundation REQUIRED)

target_link_libraries(_vtenc PRIVATE
  ${VIDEOTOOLBOX_LIB} ${COREVIDEO_LIB} ${COREMEDIA_LIB} ${COREFOUNDATION_LIB} ${FOUNDATION_LIB})

install(TARGETS _vtenc LIBRARY DESTINATION pdum/vtenc)
