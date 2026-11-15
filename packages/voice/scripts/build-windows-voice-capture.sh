#!/bin/sh
# Build the Windows capture helper in an MSYS2 UCRT64 shell.
# Static link first. If section 10.1 shows the WebRTC package has no static
# library, drop -static and copy the DLLs listed by `ntldd -R` next to the exe.
# This script is not run from macOS.

set -eu
cd "$(dirname "$0")/.."
mkdir -p prebuilds/win32-x64

g++ -O2 -std=c++17 -municode native/windows-voice-capture.cpp \
  $(pkg-config --cflags --static --libs webrtc-audio-processing-1) \
  -lole32 -loleaut32 -luuid -lavrt -lksuser \
  -static -static-libgcc -static-libstdc++ \
  -o prebuilds/win32-x64/dsh-agi-voice-capture.exe
